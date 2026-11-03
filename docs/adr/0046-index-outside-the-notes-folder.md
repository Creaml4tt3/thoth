# ADR-0046: The search index lives outside the notes folder

- **Status:** Accepted 2026-11-02 (the aim: owner, ADR-0045 step 1); the details marked "(this ADR)" were chosen by the
  implementation agent and are open to review
- **Date:** 2026-11-02
- **Deciders:** owner (the aim, the migration rule, the notice); implementation agent (the rest, marked "(this ADR)")
- **Amends:** ADR-0001 §2 (`index.sqlite` is no longer in `.thoth/`), ADR-0008 (where the host opens the index).
  **Keeps:** ADR-0019 (one recovery per folder), ADR-0021 (Connected apps read through the running app).

## Context

Until 0.4.0 the desktop host opened each Private Space's search index at `<root>/.thoth/index.sqlite`, in WAL mode,
so SQLite also kept `index.sqlite-wal` and `index.sqlite-shm` there. ADR-0045 records a user whose notes are on an SMB
share synced by Synology Drive. Two things go wrong there:

- SQLite over a network file system can corrupt a database: its locks, and WAL's shared memory, need a local file
  system.
- A sync tool copies the index, about 11 MB for that user and changing on every save, with its `-wal` and `-shm`, to
  every computer. Two computers then fight over one cache.

The index is a cache (ADR-0001 §2): every row is rebuilt from the files and the durable records in `.thoth/`. It does
not need to travel with the notes.

## Decision

1. **Where the index lives.** In the app's data folder on this computer (`HostConfig::data_dir`, the folder Tauri
   names after `com.thothnotes.desktop`), one folder per Private Space:
   `<data>/indexes/<digest>/index.sqlite`, with SQLite's `-wal` and `-shm` beside it. `<digest>` is the hex SHA-256 of
   the canonical root path's bytes (this ADR), so it is stable for a folder and says nothing readable about it. The same
   canonical root is what the host already compares to tell whether another window has a folder open (ADR-0019), so
   two windows on one folder share one index, as before.
2. **No link is followed** (this ADR). `indexes/` and the root's folder are made owner-only (`0700`) and refused if
   either is not a real folder of this user (a link to a folder included), the way the Connected apps folder is. The
   data folder is made and put in canonical form first, so the path SQLite opens has no link of its own and
   `SQLITE_OPEN_NOFOLLOW` can refuse a link anywhere in it. On Windows, where SQLite ignores that flag, the host refuses
   a reparse point at either folder or at any of `index.sqlite`, `-wal`, `-shm` and `-journal` just before SQLite opens
   the path, as it did in `.thoth/` (the same small window between check and open remains; see ADR-0008). The
   hardening of the connection itself (ADR-0008: no `ATTACH`, the authorizer, the deadline) is unchanged.
3. **A host without a data folder** (a test harness, or a desktop start where the data folder could not be found)
   keeps its indexes in a temporary folder of its own, made on first use and removed when the host ends (this ADR). The
   index is then rebuilt on every start; nothing is written next to the notes. A data folder that cannot hold the
   index (read-only, full, or not a folder) gets the same temporary folder, with a warning in the local log that names
   only the error code, so the Private Space still opens. A link on the way is still refused (rule 2).
4. **What stays in `.thoth/`, and why.** Everything else there is either part of the Private Space (it describes these
   pages and must travel with them, like the pages do) or needs the same volume as the pages, because Thoth moves it
   into place with an atomic rename:

   | Path in `.thoth/` | Why it stays next to the notes |
   | --- | --- |
   | `tmp/` | Temp files of atomic writes; `rename` is atomic only on the same volume (ADR-0001 §5) |
   | `operations/journal/` | The write journal: names temp files in `tmp/` that recovery puts back or deletes (ADR-0001) |
   | `operations/imports/` | Import staging: staged files are renamed into the Private Space (ADR-0010) |
   | `operations/*.json` | Transfer records, the truth for moves to and from workspaces (ADR-0006) |
   | `manifests/` | Import manifests, so an interrupted import resumes from any computer (ADR-0010) |
   | `sync/` | Which pages are linked to which workspace pages (ADR-0001 §2, ADR-0006) |
   | `agent/runs/` | Agent run records of this Private Space (ADR-0007 rule 7) |
   | `config.json` | The Private Space's id (ADR-0001 §2) |
   | `order.json`, `favorites.json` | The tree order and the starred pages, the person's choices for these pages (ADR-0016, ADR-0027) |

   These are small JSON files written once per change through `tmp/`, not a database. The file API keeps refusing the
   index file names in `.thoth/` (`index.sqlite*`), because an older Thoth may still have its own index there (rule 6).
5. **Moving from an older Thoth.** When a window opens a folder that no other window of this app has open, the host
   looks for `.thoth/index.sqlite`. It is never copied: the new index starts empty and the app rebuilds it from the
   files, as it does after "Rebuild index". The old files (`index.sqlite`, `-wal`, `-shm`, and a stray `-journal`) are
   deleted, unless another program has that database open (an older Thoth on this folder, maybe on another computer).
   The host tells by asking SQLite, without waiting, to take the old database out of WAL mode, which only a lone
   connection may do (this ADR); a missing file, or one that is not a database, is not in use. Deletion goes through
   the root folder's handle, one entry at a time, so a link by one of those names is removed and never followed (on
   Windows a linked old index is not opened at all). What cannot be deleted now is tried again on the next open. A
   window that opens a folder another window already has open leaves `.thoth/` alone: the first window did this.
6. **An older Thoth on the same folder is safe.** Thoth 0.4.0 and older open `.thoth/index.sqlite` with create, find it
   missing or empty, make the schema and reconcile every file (`Vault.open`), as for a first open. The rows the index
   holds beyond pages (`operation_journal`, `external_locations`, `sync_state`, `import_jobs`) are projections of the
   JSON records in rule 4, which both versions keep, so nothing is lost either way. The next time this version opens
   the folder while the older one is closed, it deletes that index again; while the older one has it open, it leaves
   it. Each version works from its own index; the cost is a rebuild on each switch.
7. **The network drive notice.** `vault.open` answers `network: true` when the root is on a network file system:
   on macOS `statfs` `f_fstypename` `smbfs`, `nfs`, `afpfs`, `webdav`, `cifs`, `ftp`; on Linux `statfs` `f_type` NFS,
   SMB, CIFS, SMB2, AFS, Coda or NCP (FUSE is left out: it is as often local as not); on Windows a UNC path or a drive
   whose `GetDriveTypeW` is `DRIVE_REMOTE`. A folder kept in sync by a client on a local disk (Synology Drive, Dropbox,
   iCloud Drive) is local and gets no notice. The desktop app then shows one calm line with its other notices, in English
   and Thai: notes on a network or synced drive work, Thoth keeps its own data on this computer, and the same page
   should not be edited on two computers at once. Dismissing it is remembered per Private Space in this computer's
   app storage. Nothing else depends on the answer, and an answer the host cannot get is "no".

## Consequences

- Positive: SQLite runs on a local disk only, and sync tools and network shares see no database files from Thoth.
- Positive: the notes folder holds only the pages and small records that belong with them.
- Positive: two computers on one share each keep their own index and never lock each other's.
- Negative: each computer, and each version switch (rule 6), builds the index from the files once, at open.
- Negative: a folder that is renamed, moved or reached by another canonical path gets a new index (and rebuilds); the
  old one stays in `indexes/` until the data folder is cleared (see Open questions).
- Negative: "Rebuild index" is still in Settings for a broken index; deleting `.thoth/index.sqlite` by hand no longer
  rebuilds anything, since nothing reads it.

## Alternatives considered

- **Keep the index in `.thoth/` with a rollback journal instead of WAL.** Rejected: still SQLite over a network file
  system, and the sync tool still copies the database on every change.
- **One index per computer in `.thoth/` (`index-<computer>.sqlite`).** Rejected: the same two problems, multiplied.
- **Key the folder by the Private Space id in `config.json`.** Survives renames, but a copied folder has the same id
  and two folders would share one index, and the host would have to read a file anyone with access to the share can
  change before it knows where its database is. The canonical path is the key the host already trusts (ADR-0019).
- **An index in memory only.** Rejected: a full rebuild on every open, and two windows on one folder could not share
  it.
- **Copy the old index to the new place.** Rejected by the owner: the index is rebuildable, and a copy would carry
  over whatever corruption the network drive caused.

## Open questions

- Indexes of folders that are no longer opened stay in `indexes/`. A later change could delete those of folders not in
  the recent list after some time.
- The privacy notice says the Private Space stays on the person's computer; it could add that the search index is kept
  in the app's data folder (docs/legal is changing on another branch).
