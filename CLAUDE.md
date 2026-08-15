# Claude working agreement

## Completion boundary (merge is part of the task)

- Unless the user explicitly asks to keep the work local, stop before publishing, leave a PR
  unmerged, or otherwise names a narrower keeping boundary, repository changes are complete only
  after intentional commits, push, PR creation, required CI, merge, post-merge CI, and local
  default-branch synchronization all succeed.
