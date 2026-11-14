# LAN sync v2 and local undo

## User contract

- Undo targets local operations only. Receiving a LAN update never adds an undo step.
- Undo produces a new local modification and synchronizes like any other edit.
- Only affected fields are reversed; unrelated remote changes remain intact.
- If an affected field's version changed, undo returns a conflict without saving or consuming the step. Returning to the same text does not bypass this version check (ABA protection).
- Undo history remains device-local and in memory (20 steps, with the existing tray/lock lifecycle). It is not transmitted or restored after process restart.

## State and operation identity

`causal.rs` implements state-based, multi-value field registers with dotted version vectors. An operation ID is `(device, sequence)`. The local UUID is stored in `replica-id.json`, separate from the replicated workspace. The next sequence comes from the workspace clock. Changed field registers, their operation IDs and their observed context are saved together using the existing atomic, optionally encrypted workspace write.

UI saves carry a base snapshot. Rust computes the requested field delta, checks affected field versions against the latest disk state, and applies only that delta. AI, CLI and undo use the same commit implementation. The save returns the authoritative workspace to the UI. Navigation is local and not part of the replicated revision.

Each task/list has an `exists` register; deletion retains its other registers. Restoring a deleted task writes a new `exists=true` version that observes its old deletion. Re-delivering the old deletion cannot remove it. A distinct, concurrent deletion can still win. A subsequent intentional deletion also wins causally.

Different fields merge independently. Dominated versions are removed; concurrent alternatives remain stored. A deterministic winner is displayed (false wins concurrent boolean ties, then operation ID). This is not a wall-clock comparison. A later edit that observes the alternatives supersedes them. There is currently no conflict-selection UI for concurrent alternatives; undo detects conflicting versions rather than silently overwriting them.

Ordering uses per-entity position fields with stable ID tie-breaking. Parent graph repair and parent completion remain deterministic derived projections. This is not a sequence/text CRDT: simultaneous reorderings choose field winners, rather than guaranteeing both ordering intentions.

Undo entries retain before/after snapshots locally, but **do not restore those snapshots wholesale**. They calculate a conditional inverse field delta against current state. Deleting/restoring containers checks relevant membership versions as well. After a successful undo, earlier local undo entries are rebased only for fields actually reversed, allowing consecutive undo without accepting unrelated remote versions.

## Transport and compatibility

Both Windows and Android use the same Rust implementation. LAN discovery is `onebyone-lan-v2`, and the request tag is `sync_v2_req` with protocol `2`. The distinct tag prevents old responders from interpreting a new causal snapshot as a legacy overwrite. **Upgrade both devices before using LAN sync.** Existing pairing keys remain usable.

Transport still exchanges encrypted full state, not an append-only operation log. This includes the clock, current registers, concurrent alternatives and deletion versions. A disconnected device can therefore catch up without every device retaining identical undo stacks or every superseded operation. Existing retries remain idempotent because merges deduplicate by operation ID. The existing transport message-size limit still applies.

## Migration and retention

Legacy snapshots are seeded deterministically. Existing timestamps are used only for comparisons between legacy seed versions; new modifications use causal context and device sequences. Legacy data cannot retroactively acquire causal relationships it never recorded. If legacy devices already disagree, inspect the merged result after upgrading.

Before the first native write replacing legacy data, the original bytes are retained as `todos-before-causal-v2.json`. An encrypted original remains encrypted in that backup. This backup is a migration snapshot, not an ongoing history service; later password changes do not re-encrypt it.

Deletion registers and vector-clock entries are retained. There is **no time-based tombstone expiration** on the v2 path. Safe garbage collection would require acknowledged device progress and a rebootstrap policy for retired devices; this implementation deliberately does not claim that compaction is implemented.

## Verification

`cargo test --manifest-path src-tauri/Cargo.toml --lib` covers delayed deletion replay after restore, subsequent intentional deletion, independent-field merges, conflicting undo, concurrent delete, repeated undo, container membership conflicts, stale UI saves, serialization/sequence persistence, merge laws, and encrypted TCP exchange. Frontend tests and `npm run build` check the existing editor refresh and TypeScript integration.

Windows/Android lifecycle and network-switching behavior still require actual-device acceptance testing.
