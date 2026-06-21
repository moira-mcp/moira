# Rebase Guide

## Why This Matters

Rebase rewrites history. When conflicts arise it is easy to lose code or make the wrong call. A careless rebase can:

- Lose functionality from one of the branches
- Break code that used to work
- Introduce bugs that are hard to trace

## How to Resolve Conflicts Correctly

### 1. Study Both Sides

A conflict means the same file changed in both `master` and the feature branch. You can't simply "take ours" or "take theirs" — you need to understand:

- What changed in `master` and why
- What changed in the feature branch and why
- How to combine both changes

### 2. Understand the Cause of the Conflict

Conflicts arise when:

- The same file was edited in both branches
- The same line/block changed in different ways
- A file was deleted in one branch and modified in the other

Understanding the cause helps you make the right decision.

### 3. Look Beyond a Single File

Functionality is often spread across several files. If the conflict is in `api.ts`, you may also need to look at:

- Types in `types.ts`
- Usage in `component.tsx`
- Tests in `api.test.ts`

Resolving a conflict in one file without understanding the context can break related code.

### 4. Account for the Number of Commits

When rebasing several commits, conflicts can occur at each step. Keep track of:

- Which functionality lives in which commit
- How the commits relate to each other
- What was already resolved in earlier conflicts

### 5. Be Careful When "Taking the Whole File"

If you decide to take a whole file from one branch:

- Make sure you understand where it comes from (`--ours` vs `--theirs` are easy to confuse)
- Check that you are not losing important changes from the other branch
- During a rebase the `ours`/`theirs` semantics differ from a merge

### 6. Don't Lose Anything Important

The golden rule: the resolution must preserve functionality from both branches. If it is unclear how to combine them, it is better to stop and figure it out than to lose code.

## After Resolving

Always verify that nothing was lost:

- Run the tests
- Confirm the functionality works
- Review the final diff
