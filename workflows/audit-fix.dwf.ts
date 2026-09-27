/* zcode-workflow
description: "Implémente UNE tâche d'un plan d'audit (implémenteur avec garde-fous
  git stricts) et retourne son checkpoint. PAS de revalidation ni de commit ici :
  la revalidation est faite par l'agent auditeur du même type (architecture-auditor
  pour l'architecture, etc.) et le commit par l'agent principal après ACCEPTED —
  le duo opencode (Flash implémente / GLM-5.3 revalide), tout en Start Plan. Si le
  quota s'épuise, le workflow retourne quota_exhausted avec resetAt pour bascule
  AmendWorkflow (subagent_model vers le routeur) + reprise avec cache."
whenToUse: "Après validation utilisateur d'un plan d'audit : l'agent principal lance
  ce workflow par tâche (task = {id, title, details}), puis dispatch l'auditeur du
  même type via l'Agent tool pour revalider, puis commit après ACCEPTED."
args:
  planPath:
    type: string
    description: Chemin relatif du plan d'audit (ex. plan/2026-09-27-arch-plan.md).
    required: true
  branch:
    type: string
    description: Branche de correction imposée (ex. fix/audit-mon-slug). Créée si
      absente, jamais la branche de base.
    required: true
  task:
    type: json
    description: "La tâche à implémenter : {id, title, details}."
    required: true
  repoPath:
    type: string
    description: "Chemin du dépôt git cible quand il diffère du workspace courant
      (les opérations git utilisent alors git -C <repoPath>). Vide = workspace."
    required: false
*/
interface TaskSpec {
  /** Identifiant de la tâche dans le plan (ex. T-01). */
  id: string;
  /** Titre de la tâche. */
  title: string;
  /** Détails : fichiers visés, changement attendu, critères d'acceptation, commandes de validation. */
  details: string;
}
interface ImplCheckpoint {
  /** Branche git active déclarée par l'implémenteur. */
  branch: string;
  /** Ce qui a été fait pour la tâche. */
  taskDone: string;
  /** Résultats des commandes de validation (pass/fail). */
  verification: string;
  /** Tâches/scénarios cochés dans le plan. */
  ticked: string;
}

const planPath = String(args.planPath);
const branch = String(args.branch);
const repoPath = typeof args.repoPath === "string" && args.repoPath.trim() !== "" ? args.repoPath.trim() : "";
// When the target repository differs from the workspace, every git call is
// redirected with -C so branch checks hit the right repository.
const gitArgs = (rest: string[]): string[] => (repoPath === "" ? rest : ["-C", repoPath, ...rest]);
const rawTask = args.task;
if (!rawTask || typeof rawTask !== "object") {
  throw new Error("args.task doit être un objet {id, title, details}");
}
const task = rawTask as TaskSpec;
if (!task.id || !task.title) {
  throw new Error("args.task incomplet : id et title sont requis");
}

const implementerPersona =
  "You are a senior developer. You receive an audit plan and implement ONE task at a time, faithfully and only what the task requires: never invent additional changes, never guess. " +
  "Protocol: (0) read the plan file from disk at the start of every task - it is the single source of truth; if the plan does not match the actual code, STOP and end with a DIVERGENCE block listing each discrepancy. " +
  "(1) BRANCH ISOLATION: the branch name comes from the brief. If it does not exist, create it with git switch -c; if already on it, continue. Never modify the base branch; state the active branch in every checkpoint. " +
  "(2) Implement exactly this one task, all code commented in English, tests in a tests/ directory next to the module when the plan requires them. " +
  "(3) Run the verification commands from the plan exactly once (tests, formatter, linter); on failure fix only the failing issue and run once more; if it still fails STOP and report the blocker. Tick the completed task in the plan file only after its acceptance criterion is verified. " +
  "(4) Stop after the task with a compact checkpoint: active branch, files touched, verification results, tasks ticked. Do NOT commit at this stage: the commit happens only after the same-type auditor returns ACCEPTED. " +
  "Guardrails: never run git reset, git checkout --, git restore, git revert, git stash, git clean, git rebase, rm, mv or any destructive operation - fix forward only. Never push in any form. Never add, remove or renumber tasks in the plan. Never work for long stretches: one task, one checkpoint. " +
  "Si un contrôle est impossible à passer ou si les instructions se contredisent, escalade et dis-le clairement plutôt que de bricoler.";

phase("Implémenter la tâche et vérifier la branche");
const impl = agent(`implementeur-${task.id}`, { system: implementerPersona });
let work: ImplCheckpoint;
try {
  work = await impl.ask<ImplCheckpoint>(
    `Tâche ${task.id}. Plan: ${planPath}. Branche imposée: ${branch}. ` +
      (repoPath === "" ? "" : `Le dépôt git cible est ${repoPath} (différent du workspace): exécute TOUTES tes opérations git avec git -C ${repoPath} …\n`) +
      `Tâche: ${task.title}\nDétails: ${task.details}\n` +
      `Applique le protocole: lis le plan, vérifie la branche, implémente CETTE tâche seulement, passe les vérifications, coche la tâche dans le plan, rends ton checkpoint. NE commite PAS: le commit n'intervient qu'après ACCEPTED du même-type auditeur.`,
  );
} catch (error) {
  const err = error as { code?: string; message?: string; providerStop?: { kind?: string; resetAt?: string } };
  if (err.code === "ProviderStop" && err.providerStop?.kind === "quota") {
    report({ event: "quota_epuise", tache: task.id, resetAt: err.providerStop.resetAt ?? "" });
    return {
      status: "quota_exhausted",
      checkpoint: null,
      resetAt: err.providerStop.resetAt ?? "",
      note: err.message ?? "quota épuisé — bascule AmendWorkflow vers failover/implementer puis reprise",
    };
  }
  throw error;
}
const branchCheck = await world.run("git", gitArgs(["branch", "--show-current"]));
const branchOk = branchCheck.stdout.trim() === branch;
if (!branchOk) {
  return {
    status: "branch_mismatch",
    checkpoint: work,
    resetAt: "",
    note: `Garde-fou: branche active '${branchCheck.stdout.trim()}' différente de la branche imposée '${branch}' — aucune revalidation ni commit.`,
  };
}
return {
  status: "implemented",
  checkpoint: work,
  resetAt: "",
  note: "À faire par l'agent principal: dispatch l'auditeur du même type (architecture-auditor pour architecture, etc.) pour revalider, puis commit après ACCEPTED.",
};
