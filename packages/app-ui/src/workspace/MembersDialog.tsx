import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { INVITE_EXPIRY_DAYS, INVITE_ROLES, INVITE_USES, RoleSchema, TEAM_NAME_MAX, roleCan, type InviteExpiry, type InviteLink, type InviteLinkCreated, type InviteRole, type InviteUses, type Member, type Role, type Team, type TeamPageList } from "@thoth/workspace-protocol";
import { ProblemError, type WorkspaceClient } from "@thoth/workspace-client";
import { shellRoot } from "../order/ContextMenu.tsx";
import { useStrings } from "../strings/index.ts";
import { Button } from "../ui/Button.tsx";
import { copyText } from "../ui/clipboard.ts";
import { Modal } from "../ui/Modal.tsx";

type MembersClient = Pick<WorkspaceClient, "getMe" | "listMembers" | "setMemberRole" | "removeMember" | "createInviteLink" | "listInviteLinks" | "revokeInviteLink"> &
  Partial<Pick<WorkspaceClient, "listTeams" | "createTeam" | "renameTeam" | "deleteTeam" | "setTeamMember" | "listTeamPages">>;

interface Props {
  client: MembersClient;
  workspace: { id: string; name: string; role: Role };
  /** The signed-in account's ID, when the host already knows it (else it is read from `/me`). */
  me?: string;
  /** The server offers invite links (`invite-links`). */
  canInvite: boolean;
  /** The server offers teams (`teams`, ADR-0042). */
  canTeams?: boolean;
  /** The server's `maxMembersPerWorkspace`, to offer no more uses than there is room for. */
  maxMembers?: number;
  /** After a change of members or roles: read the workspace list again. */
  onChanged(): void;
  /** The user left: the workspace is gone for them. */
  onLeft(): void;
  onClose(): void;
}

/** Owners first, in the select and in the list. */
const ROLES: readonly Role[] = RoleSchema.options;
const message = (error: unknown) => (error instanceof Error ? error.message : String(error));
const byRoleThenName = (a: Member, b: Member) => ROLES.indexOf(a.role) - ROLES.indexOf(b.role) || a.displayName.localeCompare(b.displayName) || (a.userId < b.userId ? -1 : 1);

type Confirm = { kind: "remove"; member: Member } | { kind: "leave" } | null;

/**
 * "Members…" of a workspace (ADR-0024). Everyone sees the members and their roles and can leave. Owners and managers
 * (ADR-0043) also change roles and remove members (managers never touch owners, nor make one), and make invite links
 * (a role, an expiry and a number of uses), copy a new link once, and see and revoke the active ones. Removing and
 * leaving ask first, inline, so focus stays in the dialog. Changes are told to screen readers in a live region;
 * refusals (such as the last owner) are alerts.
 */
export function MembersDialog({ client, workspace, me: knownMe, canInvite, canTeams = false, maxMembers, onChanged, onLeft, onClose }: Props) {
  const strings = useStrings();
  const t = strings.members;
  const owner = workspace.role === "owner";
  /** Owners and managers run the members; only owners touch owners (ADR-0043). */
  const admin = roleCan(workspace.role, "manage");
  const canChange = (m: Member) => admin && (owner || m.role !== "owner");
  const choices = owner ? ROLES : ROLES.filter((r) => r !== "owner");
  const [me, setMe] = useState<string | null>(knownMe ?? null);
  const [members, setMembers] = useState<Member[] | null>(null);
  const [links, setLinks] = useState<InviteLink[] | null>(null);
  const [created, setCreated] = useState<InviteLinkCreated | null>(null);
  const [role, setRole] = useState<InviteRole>("editor");
  const [expiry, setExpiry] = useState<InviteExpiry>(7);
  const [uses, setUses] = useState<InviteUses>(1);
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState<Confirm>(null);
  const [error, setError] = useState<string | null>(null);
  const [said, setSaid] = useState("");
  const field = useRef<HTMLInputElement>(null);
  const confirmButton = useRef<HTMLButtonElement>(null);
  const ids = { list: useId(), invite: useId(), role: useId(), expiry: useId(), uses: useId(), url: useId(), once: useId(), active: useId(), confirm: useId() };
  const day = useMemo(() => new Intl.DateTimeFormat(strings.lang, { dateStyle: "medium" }), [strings.lang]);
  const live = useRef(true);
  useEffect(
    () => () => {
      live.current = false;
    },
    [],
  );

  const fail = useCallback((e: unknown, wrap: (detail: string) => string) => {
    if (!live.current) return;
    setError(e instanceof ProblemError && e.code === "last_owner" ? t.lastOwner : wrap(message(e)));
  }, [t]);

  const reloadMembers = useCallback(async () => {
    try {
      const next = await client.listMembers(workspace.id);
      if (live.current) setMembers(next.sort(byRoleThenName));
    } catch (e) {
      if (!live.current) return;
      setMembers((prev) => prev ?? []);
      fail(e, t.loadFailed);
    }
  }, [client, workspace.id, fail, t]);

  const reloadLinks = useCallback(async () => {
    if (!admin || !canInvite) return;
    try {
      const next = await client.listInviteLinks(workspace.id);
      if (live.current) setLinks(next);
    } catch (e) {
      if (!live.current) return;
      setLinks((prev) => prev ?? []);
      fail(e, t.linksFailed);
    }
  }, [client, workspace.id, admin, canInvite, fail, t]);

  useEffect(() => {
    void reloadMembers();
    void reloadLinks();
  }, [reloadMembers, reloadLinks]);

  useEffect(() => {
    if (me !== null) return;
    client
      .getMe()
      .then((who) => live.current && setMe(who.id))
      .catch(() => undefined);
  }, [client, me]);

  // A new address is selected at once, so Cmd/Ctrl+C copies it as well as the button does.
  useEffect(() => {
    if (created) field.current?.select();
  }, [created]);
  // The question takes focus, so the keyboard answers it next.
  useEffect(() => {
    if (confirm) confirmButton.current?.focus();
  }, [confirm]);

  const room = maxMembers === undefined || members === null ? Infinity : Math.max(0, maxMembers - members.length);
  useEffect(() => {
    if (uses > room) setUses(INVITE_USES.filter((n) => n <= room).at(-1) ?? 1);
  }, [room, uses]);

  const changeRole = async (member: Member, next: Role) => {
    setError(null);
    setSaid("");
    try {
      await client.setMemberRole(workspace.id, member.userId, next);
      if (!live.current) return;
      setSaid(t.roleChanged(member.displayName, t.roles[next]));
      onChanged();
    } catch (e) {
      fail(e, t.failed);
    }
    await reloadMembers();
  };

  const remove = async (member: Member) => {
    setConfirm(null);
    setError(null);
    setSaid("");
    try {
      await client.removeMember(workspace.id, member.userId);
      if (!live.current) return;
      setSaid(t.removed(member.displayName));
      onChanged();
    } catch (e) {
      fail(e, t.failed);
    }
    await reloadMembers();
  };

  const leave = async () => {
    setConfirm(null);
    setError(null);
    if (me === null) return;
    try {
      await client.removeMember(workspace.id, me);
      if (live.current) onLeft();
    } catch (e) {
      fail(e, t.failed);
    }
  };

  const create = async () => {
    setBusy(true);
    setError(null);
    setSaid("");
    try {
      const link = await client.createInviteLink(workspace.id, { role, expiresInDays: expiry, maxUses: uses });
      if (!live.current) return;
      setCreated(link);
      await reloadLinks();
    } catch (e) {
      fail(e, t.inviteFailed);
    } finally {
      if (live.current) setBusy(false);
    }
  };

  const copy = async () => {
    if (!created) return;
    try {
      await copyText(created.url);
      setSaid(t.copied);
    } catch {
      field.current?.select();
      setSaid(t.copyFailed);
    }
  };

  const revoke = async (link: InviteLink) => {
    setError(null);
    try {
      await client.revokeInviteLink(workspace.id, link.id);
      if (!live.current) return;
      if (created?.id === link.id) setCreated(null);
      setSaid(t.revoked);
      await reloadLinks();
    } catch (e) {
      fail(e, t.revokeFailed);
    }
  };

  const name = (m: Member) => (m.userId === me ? `${m.displayName} (${t.you})` : m.displayName);

  const question =
    confirm === null ? null : (
      <div className="members-confirm" role="group" aria-labelledby={ids.confirm}>
        <p id={ids.confirm} className="members-confirm-title">
          {confirm.kind === "remove" ? t.confirmRemove(confirm.member.displayName) : t.confirmLeave(workspace.name)}
        </p>
        <p className="share-note">{confirm.kind === "remove" ? t.confirmRemoveBody : t.confirmLeaveBody}</p>
        <div className="move-actions">
          <Button variant="quiet" small onClick={() => setConfirm(null)}>
            {t.cancel}
          </Button>
          <Button ref={confirmButton} variant="danger" small onClick={() => void (confirm.kind === "remove" ? remove(confirm.member) : leave())}>
            {confirm.kind === "remove" ? t.removeConfirm : t.leaveConfirm}
          </Button>
        </div>
      </div>
    );

  return createPortal(
    <Modal title={t.title(workspace.name)} onClose={onClose} wide>
      <p className="share-intro">{t.intro}</p>
      <section className="share-active" aria-labelledby={ids.list}>
        <h3 id={ids.list} className="share-heading">
          {t.list}
        </h3>
        {members === null ? (
          <p className="share-note">{t.loading}</p>
        ) : (
          <ul className="members-list" aria-labelledby={ids.list}>
            {members.map((m) => (
              <li key={m.userId} className="member">
                <span className="member-name">
                  <span>{name(m)}</span>
                  <span className="share-note member-hint">{t.roleHints[m.role]}</span>
                </span>
                {canChange(m) ? (
                  <select className="input member-role" aria-label={t.roleOf(m.displayName)} value={m.role} onChange={(event) => void changeRole(m, event.target.value as Role)}>
                    {choices.map((r) => (
                      <option key={r} value={r}>
                        {t.roles[r]}
                      </option>
                    ))}
                  </select>
                ) : (
                  <span className="badge badge-muted member-badge">{t.roles[m.role]}</span>
                )}
                {canChange(m) && m.userId !== me && (
                  <Button small variant="quiet" aria-label={t.removeLabel(m.displayName)} onClick={() => setConfirm({ kind: "remove", member: m })}>
                    {t.remove}
                  </Button>
                )}
              </li>
            ))}
          </ul>
        )}
        {!admin && <p className="share-note">{t.readOnlyNote}</p>}
        {admin && !owner && <p className="share-note">{t.ownersNote}</p>}
        <div className="members-leave">
          <Button variant="danger" small disabled={me === null} onClick={() => setConfirm({ kind: "leave" })}>
            {t.leave}
          </Button>
        </div>
        {question}
      </section>

      {canTeams && members !== null && <TeamsSection client={client} workspace={workspace} members={members} />}

      {admin && canInvite && (
        <section className="members-invite" role="region" aria-labelledby={ids.invite}>
          <h3 id={ids.invite} className="share-heading">
            {t.invite}
          </h3>
          <p className="share-note">{t.inviteIntro}</p>
          <form
            className="form"
            onSubmit={(event) => {
              event.preventDefault();
              void create();
            }}
          >
            <fieldset className="share-expiry">
              <legend id={ids.role}>{t.inviteRole}</legend>
              <div className="share-choices">
                {INVITE_ROLES.map((r) => (
                  <label key={r} className="share-choice">
                    <input type="radio" name="invite-role" checked={role === r} disabled={busy} onChange={() => setRole(r)} />
                    <span>{t.roles[r]}</span>
                  </label>
                ))}
              </div>
            </fieldset>
            <fieldset className="share-expiry">
              <legend id={ids.expiry}>{t.inviteExpiry}</legend>
              <div className="share-choices">
                {INVITE_EXPIRY_DAYS.map((d) => (
                  <label key={d} className="share-choice">
                    <input type="radio" name="invite-expiry" checked={expiry === d} disabled={busy} onChange={() => setExpiry(d)} />
                    <span>{t.days(d)}</span>
                  </label>
                ))}
              </div>
            </fieldset>
            <fieldset className="share-expiry">
              <legend id={ids.uses}>{t.inviteUses}</legend>
              <div className="share-choices">
                {INVITE_USES.map((n) => (
                  <label key={n} className="share-choice" data-disabled={n > room || undefined}>
                    <input type="radio" name="invite-uses" checked={uses === n} disabled={busy || n > room} onChange={() => setUses(n)} />
                    <span>{t.people(n)}</span>
                  </label>
                ))}
              </div>
              {room < 1 && <p className="share-note">{t.noRoom}</p>}
            </fieldset>
            <div className="move-actions">
              <Button variant="primary" type="submit" disabled={busy || room < 1}>
                {busy ? t.creating : t.create}
              </Button>
            </div>
          </form>
          {created && (
            <div className="share-new">
              <label htmlFor={ids.url} className="share-label">
                {t.newLink}
              </label>
              <div className="share-copy">
                <input id={ids.url} ref={field} className="input mono" readOnly value={created.url} aria-describedby={ids.once} onFocus={(event) => event.currentTarget.select()} />
                <Button variant="primary" onClick={() => void copy()}>
                  {t.copy}
                </Button>
              </div>
              <p id={ids.once} className="share-note">
                {t.onlyOnce}
              </p>
            </div>
          )}
          <h4 id={ids.active} className="share-heading">
            {t.active}
          </h4>
          {links === null ? (
            <p className="share-note">{t.loadingLinks}</p>
          ) : links.length === 0 ? (
            <p className="share-note">{t.none}</p>
          ) : (
            <ul className="share-links" aria-labelledby={ids.active}>
              {links.map((link) => {
                const until = day.format(new Date(link.expiresAt));
                return (
                  <li key={link.id} className="share-link">
                    <span>{t.linkLine(t.roles[link.role], link.usesLeft, until, link.createdByName)}</span>
                    <Button small variant="quiet" aria-label={t.revokeLabel(t.roles[link.role], until)} onClick={() => void revoke(link)}>
                      {t.revoke}
                    </Button>
                  </li>
                );
              })}
            </ul>
          )}
        </section>
      )}

      <p role="status" className="share-said">
        {said}
      </p>
      {error !== null && (
        <p role="alert" className="alert alert-danger">
          {error}
        </p>
      )}
      <div className="modal-actions">
        <Button variant="quiet" onClick={onClose}>
          {t.done}
        </Button>
      </div>
    </Modal>,
    shellRoot(),
  );
}

/**
 * Teams of the workspace (ADR-0042): every member sees them and who is in each; owners and managers create, rename and
 * delete teams and tick who is in each. Each change is said in the live region; a failure is an alert.
 */
function TeamsSection({ client, workspace, members }: { client: MembersClient; workspace: { id: string; role: Role }; members: Member[] }) {
  const strings = useStrings();
  const t = strings.members;
  const manage = roleCan(workspace.role, "manage");
  const [teams, setTeams] = useState<Team[] | null>(null);
  const [name, setName] = useState("");
  const [names, setNames] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [said, setSaid] = useState("");
  const [error, setError] = useState<string | null>(null);
  const ids = { heading: useId(), name: useId(), confirm: useId() };
  /** "Delete team" asks first, listing the folders limited to it (ADR-0043); `pages` is null while they load. */
  const [deleting, setDeleting] = useState<{ team: Team; pages: TeamPageList["items"] | null } | null>(null);
  const confirmButton = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (deleting?.pages) confirmButton.current?.focus();
  }, [deleting?.pages]);

  const askDelete = async (team: Team) => {
    setError(null);
    setDeleting({ team, pages: client.listTeamPages ? null : [] });
    if (!client.listTeamPages) return;
    try {
      const pages = await client.listTeamPages(workspace.id, team.id);
      setDeleting((now) => (now?.team.id === team.id ? { team, pages } : now));
    } catch (e) {
      setDeleting(null);
      setError(t.teamsFailed(message(e)));
    }
  };

  const reload = useCallback(async () => {
    try {
      setTeams((await client.listTeams?.(workspace.id)) ?? []);
    } catch (e) {
      setTeams((prev) => prev ?? []);
      setError(t.teamsFailed(message(e)));
    }
  }, [client, workspace.id, t]);
  useEffect(() => void reload(), [reload]);

  const act = async (job: () => Promise<unknown>, done: string) => {
    setBusy(true);
    setError(null);
    setSaid("");
    try {
      await job();
      setSaid(done);
    } catch (e) {
      setError(t.teamsFailed(message(e)));
    } finally {
      setBusy(false);
      await reload();
    }
  };

  const nameOf = (id: string) => members.find((m) => m.userId === id)?.displayName ?? id;

  return (
    <section className="members-teams" role="region" aria-labelledby={ids.heading}>
      <h3 id={ids.heading} className="share-heading">
        {t.teams}
      </h3>
      <p className="share-note">{t.teamsIntro}</p>
      {teams === null ? (
        <p className="share-note">{t.loadingTeams}</p>
      ) : teams.length === 0 ? (
        <p className="share-note">{t.noTeams}</p>
      ) : (
        <ul className="members-list" aria-labelledby={ids.heading}>
          {teams.map((team) => (
            <li key={team.id} className="member team">
              {manage ? (
                <form
                  className="share-copy"
                  onSubmit={(event) => {
                    event.preventDefault();
                    const next = (names[team.id] ?? team.name).trim();
                    if (next && next !== team.name) void act(() => client.renameTeam!(workspace.id, team.id, next), t.teamRenamed(next));
                  }}
                >
                  <input className="input" aria-label={t.teamName(team.name)} maxLength={TEAM_NAME_MAX} value={names[team.id] ?? team.name} disabled={busy} onChange={(event) => setNames({ ...names, [team.id]: event.target.value })} />
                  <Button small variant="quiet" type="submit" disabled={busy}>
                    {t.renameTeam}
                  </Button>
                  <Button small variant="quiet" aria-label={t.deleteTeamLabel(team.name)} disabled={busy} onClick={() => void askDelete(team)}>
                    {t.deleteTeam}
                  </Button>
                </form>
              ) : (
                <span className="member-name">
                  <span>{team.name}</span>
                  <span className="share-note member-hint">{team.memberIds.map(nameOf).join(", ") || t.teamMembers(0)}</span>
                </span>
              )}
              {manage && (
                <fieldset className="share-expiry">
                  <legend className="sr-only">{team.name}</legend>
                  <div className="share-choices">
                    {members.map((m) => (
                      <label key={m.userId} className="share-choice">
                        <input
                          type="checkbox"
                          aria-label={t.teamMember(m.displayName, team.name)}
                          checked={team.memberIds.includes(m.userId)}
                          disabled={busy}
                          onChange={(event) => void act(() => client.setTeamMember!(workspace.id, team.id, m.userId, event.target.checked), t.teamChanged(team.name))}
                        />
                        <span>{m.displayName}</span>
                      </label>
                    ))}
                  </div>
                </fieldset>
              )}
            </li>
          ))}
        </ul>
      )}
      {deleting && (
        <div className="members-confirm" role="group" aria-labelledby={ids.confirm}>
          <p id={ids.confirm} className="members-confirm-title">
            {t.confirmDeleteTeam(deleting.team.name)}
          </p>
          {deleting.pages === null ? (
            <p className="share-note">{t.deleteTeamChecking}</p>
          ) : deleting.pages.length === 0 ? (
            <p className="share-note">{t.deleteTeamNothing}</p>
          ) : (
            ([true, false] as const).map((only) => {
              const pages = deleting.pages!.filter((p) => p.onlyTeam === only);
              return pages.length === 0 ? null : (
                <div key={String(only)}>
                  <p className="share-note">{only ? t.deleteTeamOnly : t.deleteTeamShared}</p>
                  <ul className="share-note">
                    {pages.map((p) => (
                      <li key={p.pageId}>{p.title || strings.tabs.untitled}</li>
                    ))}
                  </ul>
                </div>
              );
            })
          )}
          <div className="move-actions">
            <Button variant="quiet" small onClick={() => setDeleting(null)}>
              {t.cancel}
            </Button>
            <Button
              ref={confirmButton}
              variant="danger"
              small
              disabled={busy || deleting.pages === null}
              onClick={() => {
                const team = deleting.team;
                setDeleting(null);
                void act(() => client.deleteTeam!(workspace.id, team.id), t.teamDeleted(team.name));
              }}
            >
              {t.deleteTeamConfirm}
            </Button>
          </div>
        </div>
      )}
      {manage && (
        <form
          className="share-copy"
          onSubmit={(event) => {
            event.preventDefault();
            const next = name.trim();
            if (!next) return;
            void act(() => client.createTeam!(workspace.id, next), t.teamCreated(next)).then(() => setName(""));
          }}
        >
          <input id={ids.name} className="input" aria-label={t.newTeam} placeholder={t.newTeam} maxLength={TEAM_NAME_MAX} value={name} disabled={busy} onChange={(event) => setName(event.target.value)} />
          <Button variant="primary" type="submit" disabled={busy || name.trim() === ""}>
            {t.createTeam}
          </Button>
        </form>
      )}
      <p role="status" className="share-said">
        {said}
      </p>
      {error !== null && (
        <p role="alert" className="alert alert-danger">
          {error}
        </p>
      )}
    </section>
  );
}
