/* Exercise the actual Linux settlement observer, with a zombie leader and a live socket owner. */
#define main original_helper_main
#include "../../../packages/local/src/process-group-helper.c"
#undef main
#include <pthread.h>
#include <poll.h>
#include <sys/socket.h>
#include <sys/un.h>
#include <sys/syscall.h>

static int ready_write;
static char endpoint[108];

static void *held_listener(void *unused) {
  (void)unused;
  int server = socket(AF_UNIX, SOCK_STREAM, 0);
  struct sockaddr_un address = {.sun_family = AF_UNIX};
  strcpy(address.sun_path, endpoint);
  if (server < 0 || bind(server, (struct sockaddr *)&address, sizeof(address)) ||
      listen(server, 1) || write(ready_write, "r", 1) != 1) _exit(90);
  close(ready_write);
  int peer = accept(server, NULL, NULL);
  char bytes[32];
  ssize_t count = read(peer, bytes, sizeof(bytes));
  if (count > 0 && write(peer, bytes, (size_t)count) == count) {
    close(peer);
    for (;;) pause();
  }
  _exit(91);
}

int main(void) {
  /* The caller's watchdog requests cleanup; elapsed time never proves settlement. */
  struct sigaction action; memset(&action, 0, sizeof(action)); action.sa_handler = cancel;
  sigemptyset(&action.sa_mask);
  if (sigaction(SIGTERM, &action, NULL) || sigaction(SIGINT, &action, NULL)) return 79;
  char directory[] = "/tmp/moira-thread-custody-XXXXXX";
  if (!mkdtemp(directory)) return 80;
  snprintf(endpoint, sizeof(endpoint), "%s/held.sock", directory);
  int ready[2];
  if (pipe(ready)) return 81;
  pid_t child = fork();
  if (child < 0) return 82;
  if (!child) {
    close(ready[0]); ready_write = ready[1];
    if (setsid() < 0) _exit(83);
    pthread_t worker;
    if (pthread_create(&worker, NULL, held_listener, NULL)) _exit(84);
    pthread_exit(NULL);
  }
  close(ready[1]);
  char byte;
  int ready_ok = read(ready[0], &byte, 1) == 1;
  close(ready[0]);
  char state = '?', stat_path[80], value[4096];
  snprintf(stat_path, sizeof(stat_path), "/proc/%d/stat", child);
  while (ready_ok && !cancelled) {
    FILE *file = fopen(stat_path, "r");
    if (!file) break;
    size_t length = fread(value, 1, sizeof(value)-1, file); fclose(file); value[length] = 0;
    char *fields = strrchr(value, ')');
    if (fields && sscanf(fields + 1, " %c", &state) == 1 && state == 'Z') break;
    struct timespec delay = {.tv_nsec = 1000000}; nanosleep(&delay, NULL);
  }
  int observed_live = live_group(child);
  int peer = socket(AF_UNIX, SOCK_STREAM, 0);
  struct sockaddr_un address = {.sun_family = AF_UNIX}; strcpy(address.sun_path, endpoint);
  int connected = peer >= 0 && connect(peer, (struct sockaddr *)&address, sizeof(address)) == 0;
  const char challenge[] = "owned-thread-challenge";
  int echoed = 0;
  if (connected && write(peer, challenge, sizeof(challenge)) == sizeof(challenge)) {
    struct pollfd response = {.fd = peer, .events = POLLIN};
    if (poll(&response, 1, 1000) == 1) {
      char reply[sizeof(challenge)];
      echoed = read(peer, reply, sizeof(reply)) == sizeof(reply) && !memcmp(reply, challenge, sizeof(reply));
    }
  }
  if (peer >= 0) close(peer);
  kill(-child, SIGKILL);
  int status = 0; pid_t reaped;
  do { reaped = waitpid(child, &status, 0); } while (reaped < 0 && errno == EINTR);
  int settled_live = live_group(child);
  unlink(endpoint); rmdir(directory);
  printf("{\"mainThreadState\":\"%c\",\"liveGroup\":%d,\"connected\":%s,\"challengeEchoed\":%s,\"settledGroup\":%d,\"reaped\":%s}\n", state, observed_live, connected ? "true" : "false", echoed ? "true" : "false", settled_live, reaped == child && WIFSIGNALED(status) ? "true" : "false");
  return ready_ok && state == 'Z' && observed_live == 1 && connected && echoed && settled_live == 0 && reaped == child && WIFSIGNALED(status) ? 0 : 86;
}
