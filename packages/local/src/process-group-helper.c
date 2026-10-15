/* Trusted fixed provisioning: retain an unreaped direct child until its group is quiescent. */
#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <sys/file.h>
#include <sys/wait.h>
#include <time.h>
#include <unistd.h>
#ifdef __APPLE__
#include <sys/sysctl.h>
#elif defined(__linux__)
#include <dirent.h>
#include <poll.h>
#include <sys/syscall.h>
#else
#error Unsupported provisioning platform
#endif

static volatile sig_atomic_t cancelled;
static void cancel(int signal_number) { (void)signal_number; cancelled = 1; }
/* A process is settled only after all its threads release their transports. Reaping is separate. */
static int live_group(pid_t group) {
#ifdef __APPLE__
  int mib[4] = {CTL_KERN, KERN_PROC, KERN_PROC_PGRP, group};
  size_t size = 0;
  if (sysctl(mib, 4, NULL, &size, NULL, 0)) return -1;
  if (!size) return 0;
  struct kinfo_proc *entries = malloc(size);
  if (!entries) return -1;
  if (sysctl(mib, 4, entries, &size, NULL, 0)) { free(entries); return -1; }
  int live = 0;
  for (size_t i = 0; i < size / sizeof(*entries); i++)
    if (entries[i].kp_proc.p_stat != SZOMB) live = 1;
  free(entries); return live;
#else
  DIR *directory = opendir("/proc");
  if (!directory) return -1;
  int live = 0, failed = 0;
  struct dirent *entry;
  for (;;) {
    errno = 0; entry = readdir(directory);
    if (!entry) { if (errno) failed = 1; break; }
    if (!entry->d_name[0] || strspn(entry->d_name, "0123456789") != strlen(entry->d_name)) continue;
    char path[PATH_MAX], value[4096];
    snprintf(path, sizeof(path), "/proc/%s/stat", entry->d_name);
    FILE *file = fopen(path, "r");
    if (!file) { if (errno != ENOENT && errno != ESRCH) failed = 1; continue; }
    size_t length = fread(value, 1, sizeof(value) - 1, file);
    if (!length) { if (ferror(file)) failed = 1; fclose(file); continue; }
    value[length] = 0;
    if (ferror(file)) failed = 1;
    fclose(file);
    char *fields = strrchr(value, ')'), state;
    int parent, pgid;
    if (!fields || sscanf(fields + 1, " %c %d %d", &state, &parent, &pgid) != 3) { failed = 1; continue; }
    if (pgid != group) continue;
    /* A zombie main thread can still have live sibling threads and shared file descriptors.
       As in runtime-control-helper, a process pidfd (without PIDFD_THREAD) becomes readable
       only after its last thread exits. The unreaped direct child still pins our PGID. */
    int identity = syscall(SYS_pidfd_open, (pid_t)strtol(entry->d_name, NULL, 10), 0);
    if (identity < 0) { if (errno != ESRCH) failed = 1; continue; }
    struct pollfd process = { .fd = identity, .events = POLLIN };
    int observed = poll(&process, 1, 0);
    if (observed < 0 || (observed && (!(process.revents & POLLIN) ||
        (process.revents & ~(POLLIN | POLLHUP))))) failed = 1;
    else if (!observed) live = 1;
    if (close(identity)) failed = 1;
  }
  closedir(directory); return failed ? -1 : live;
#endif
}

int main(int argc, char **argv) {
  if (argc == 6 && !strcmp(argv[1], "--inspect-custody")) {
    struct stat metadata; char bytes[80], expected[80];
    int file = open(argv[2], O_RDONLY | O_NOFOLLOW);
    if (file < 0 || fstat(file, &metadata) || !S_ISREG(metadata.st_mode) || metadata.st_uid != geteuid() || metadata.st_nlink != 1 || metadata.st_mode & 077 || metadata.st_dev != (dev_t)strtoull(argv[4], NULL, 10) || metadata.st_ino != (ino_t)strtoull(argv[5], NULL, 10)) return 254;
    if (flock(file, LOCK_SH)) return 254;
    int length = snprintf(expected, sizeof(expected), "settled:%s\n", argv[3]);
    ssize_t read_count = pread(file, bytes, sizeof(bytes), 0);
    if (read_count == length && !memcmp(bytes, expected, length)) return 0;
    length = snprintf(expected, sizeof(expected), "pending:%s\n", argv[3]);
    return read_count == length && !memcmp(bytes, expected, length) ? 1 : 254;
  }
  const char *custody_nonce = NULL;
  if (argc >= 4 && !strcmp(argv[1], "--custody")) {
    custody_nonce = argv[2];
    if (strlen(custody_nonce) != 64 || strspn(custody_nonce, "0123456789abcdef") != 64) return 254;
    struct stat witness, directory;
    char pending[80], expected[80];
    int length = snprintf(expected, sizeof(expected), "pending:%s\n", custody_nonce);
    if (fstat(4, &witness) || !S_ISREG(witness.st_mode) || witness.st_uid != geteuid() || witness.st_nlink != 1 || witness.st_mode & 077 || fstat(5, &directory) || !S_ISDIR(directory.st_mode) || directory.st_uid != geteuid() || directory.st_mode & 077 || flock(4, LOCK_EX | LOCK_NB) || pread(4, pending, sizeof(pending), 0) != length || memcmp(pending, expected, length) || fsync(4) || fsync(5)) return 254;
    argv += 2; argc -= 2;
  }
  if (argc < 2 || argv[1][0] != '/') return 254;
  char canonical[PATH_MAX]; struct stat metadata;
  if (!realpath(argv[1], canonical) || strcmp(canonical, argv[1]) || lstat(canonical, &metadata) ||
      !S_ISREG(metadata.st_mode) || (metadata.st_uid != geteuid() && metadata.st_uid != 0) || metadata.st_mode & 022) return 254;
  signal(SIGPIPE, SIG_IGN);
  /* A parent process's ignored SIGCHLD must never auto-reap our custody identity. */
  signal(SIGCHLD, SIG_DFL);
  struct sigaction action; memset(&action, 0, sizeof(action)); action.sa_handler = cancel;
  sigemptyset(&action.sa_mask);
  if (sigaction(SIGTERM, &action, NULL) || sigaction(SIGINT, &action, NULL)) return 254;
  if (fcntl(3, F_SETFL, O_NONBLOCK)) return 254;
  int ready[2]; if (pipe(ready)) return 254;
  pid_t child = fork();
  if (child < 0) return 254;
  if (!child) {
    close(ready[0]); close(3); if (custody_nonce) { close(4); close(5); }
    if (setsid() < 0 || write(ready[1], "r", 1) != 1) _exit(254);
    close(ready[1]); signal(SIGTERM, SIG_DFL); signal(SIGINT, SIG_DFL);
    execv(argv[1], argv + 1); _exit(254);
  }
  close(ready[1]); char byte; ssize_t started;
  do { started = read(ready[0], &byte, 1); } while (started < 0 && errno == EINTR);
  close(ready[0]);
  int failed = started != 1, observed_exit = 0;
  siginfo_t outcome; memset(&outcome, 0, sizeof(outcome));
  for (;;) {
    if (waitid(P_PID, child, &outcome, WEXITED | WNOHANG | WNOWAIT)) { if (errno == EINTR) continue; return 254; }
    if (outcome.si_pid == child) { observed_exit = 1; break; }
    char control; ssize_t count = read(3, &control, 1);
    if (!count || cancelled || failed) break;
    if (count > 0 || (count < 0 && errno != EAGAIN && errno != EINTR)) { failed = 1; break; }
    struct timespec delay = {.tv_nsec = 10000000}; nanosleep(&delay, NULL);
  }
  /* No waitpid/reap before this signal: child PID/PGID cannot be recycled. */
  if (started == 1 && kill(-child, SIGKILL) && errno != ESRCH) failed = 1;
  if (started != 1 && kill(child, SIGKILL) && errno != ESRCH) failed = 1;
  for (;;) {
    int live = live_group(child);
    if (live < 0) {
      struct timespec delay = {.tv_nsec = 10000000}; nanosleep(&delay, NULL); continue;
    }
    if (!live) break;
    /* A group can disappear between observation and signalling (Darwin may return EPERM).
       Retain the unreaped identity and observe again; a signal result is never settlement proof. */
    (void)kill(-child, SIGKILL);
    struct timespec delay = {.tv_nsec = 10000000}; nanosleep(&delay, NULL);
  }
  if (custody_nonce && started == 1) {
    char settled[80]; int length = snprintf(settled, sizeof(settled), "settled:%s\n", custody_nonce);
    if (pwrite(4, settled, length, 0) != length || ftruncate(4, length) || fsync(4) || fsync(5)) failed = 1;
  }
  int status;
  while (waitpid(child, &status, 0) < 0) { if (errno != EINTR) return 254; }
  if (failed) return 254;
  if (!observed_exit || outcome.si_code != CLD_EXITED) return 253;
  return outcome.si_status;
}
