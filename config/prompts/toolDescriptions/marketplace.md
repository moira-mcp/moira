Discover, adopt, publish, rate, and share workflows in the marketplace.

The marketplace is agent-operated: you can do everything headless, no copy-paste of commands.

Actions (pass `action`):

- search — find public flows. Params: `q` (text), `category`, `tags` (one tag), `sort` (recent|rating|installs|trending), `page`. Returns store cards with a `ref` ("handle/slug").
- info — full detail for one flow. Params: `ref`. Returns description, ratings, author, node count, entitlement.
- add — adopt a flow into your library. Params: `ref`, `fork` (true = editable owned copy; default = live reference that auto-updates). After add, the flow appears in `list()` and you can `start(ref)`.
- remove — remove a flow from your library. ORIGIN-AWARE: an _added_ reference is un-adopted (the original is untouched), but a flow you _own_ (e.g. your own published listing) is DELETED (and unlisted if it was published). Use with care on your own flows. Params: `ref`.
- publish — make one of your own workflows public (listed in the marketplace). Params: `workflowId`, `category`, `tags` (comma-separated), `summary`.
- unpublish — make your listed workflow private again. Params: `workflowId`.
- rate — rate/review a flow (you cannot rate your own). Params: `ref`, `stars` (1-5), `review`.
- share — privately share your workflow. Params: `workflowId`, `userHandle` (grant a specific user) or omit to generate an invite link.

Typical flow: marketplace search → marketplace info → marketplace add → list() shows it → start(ref).

Notes:

- Store actions (search/info/add/publish/rate/share) require the marketplace to be enabled; on instances where it is off they return a clear "marketplace not enabled" message, but your local library (list) still works.
- Paid listings are not sellable yet: paid fields on publish are rejected, and paid flows report entitlement "paid-coming-soon".
