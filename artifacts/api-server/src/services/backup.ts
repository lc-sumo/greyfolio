/**
 * "Download everything": one JSON document with every table the portal
 * owns. Password hashes, authenticator secrets and reset tokens are left
 * out on purpose — a backup file in a Downloads folder must not be a way in.
 */
import type { Repo } from '../repo.js';

export async function buildBackup(repo: Repo, actorRepId: string): Promise<Record<string, unknown>> {
  const [ctx, reps, teams, runs, settings, notes, files, repFiles, playbooks, firings, tasks, audit] = await Promise.all([
    repo.loadContext(),
    repo.listReps(),
    repo.listTeams(),
    repo.listRuns(),
    repo.getSettings(),
    repo.listAllNotes(),
    repo.listAllFiles(),
    repo.listAllRepFiles(),
    repo.listPlaybooks(),
    repo.listFirings({ limit: 100_000 }),
    repo.listTasks(),
    repo.listAudit(100_000, 0),
  ]);
  await repo.writeAudit({ actorRepId, action: 'backup', targetRepId: null, path: '/api/admin/backup.json', detail: { deals: ctx.deals.length, lines: ctx.lines.length, files: files.length + repFiles.length } });
  return {
    format: 'greystone-portal-backup',
    version: 1,
    exportedAt: new Date().toISOString(),
    excluded: ['password hashes', 'two-factor secrets', 'reset tokens'],
    counts: { reps: reps.length, teams: teams.length, deals: ctx.deals.length, lines: ctx.lines.length, clawbacks: ctx.clawbacks.length, runs: runs.length, notes: notes.length, files: files.length, repFiles: repFiles.length, playbooks: playbooks.length, tasks: tasks.length, audit: audit.length },
    reps,
    teams,
    deals: ctx.deals,
    lines: ctx.lines,
    clawbacks: ctx.clawbacks,
    runs,
    settings,
    notes,
    files,
    repFiles,
    playbooks,
    firings,
    tasks,
    audit,
  };
}
