/* zcode-workflow
description: "Boucle de correction d'un audit : implémente les tâches du plan
  une par une (implémenteur avec garde-fous git stricts), fait revalider chaque
  tâche par un auditeur du même type, et ne commit qu'après ACCEPTED (un commit
  par tâche, branche fix/* uniquement). Si le quota s'épuise, la boucle s'arrête
  proprement avec l'état exact (tâches faites/commitées) pour reprise par
  AmendWorkflow + cache."
whenToUse: "Après qu'un plan d'audit a été discuté (critique) et validé par
  l'utilisateur : implémente ses tâches une par une avec revalidation par
  auditeur du même type et commit après ACCEPTED. L'agent principal lance ce
  workflow par type d'audit (arch, puis perf, puis secu) et gère les validations
  utilisateur entre les phases."
args:
  auditType:
    type: string
    description: "Type d'audit en cours de correction : architecture, performance ou
      security (détermine la persona du revalidateur)."
    required: true
  branch:
    type: string
    description: Branche de correction imposée (ex. fix/audit-mon-slug). Créée si
      absente, jamais la branche de base.
    required: true
  maxRounds:
    type: number
    description: Nombre maximum de cycles correction/revalidation par tâche.
    required: false
    default: 3
  planPath:
    type: string
    description: Chemin relatif du plan d'audit à implémenter (ex.
      plan/2026-09-27-arch-plan.md).
    required: true
  tasks:
    type: json
    description: "Tableau des tâches à implémenter, extraites du plan : [{id, title,
      details}]."
    required: true
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
interface ReviewVerdict {
  /** "ACCEPTED" ou "REJECTED". */
  verdict: string;
  /** Raisons précises, corrections demandées le cas échéant. */
  notes: string;
}
interface TaskOutcome {
  /** Identifiant de la tâche traitée. */
  id: string;
  /** "validated_committed" | "blocked" | "quota_exhausted". */
  status: string;
  /** Hash du commit quand la tâche est validée et commitée, sinon vide. */
  commitHash: string;
  /** Notes : verdicts de revalidation, corrections, raison d'un blocage. */
  notes: string;
}

const planPath = String(args.planPath);
const branch = String(args.branch);
const auditType = String(args.auditType);
const maxRounds = typeof args.maxRounds === "number" ? args.maxRounds : 3;
const rawTasks = args.tasks;
if (!Array.isArray(rawTasks)) {
  throw new Error("args.tasks doit être un tableau de tâches [{id, title, details}]");
}
const tasks = rawTasks as TaskSpec[];

const implementerPersona =
  "You are a senior developer. You receive an audit plan and implement ONE task at a time, faithfully and only what the task requires: never invent additional changes, never guess. " +
  "Protocol: (0) read the plan file from disk at the start of every task - it is the single source of truth; if the plan does not match the actual code, STOP and end with a DIVERGENCE block listing each discrepancy. " +
  "(1) BRANCH ISOLATION: the branch name comes from the brief. If it does not exist, create it with git switch -c; if already on it, continue. Never modify the base branch; state the active branch in every checkpoint. " +
  "(2) Implement exactly this one task, all code commented in English, tests in a tests/ directory next to the module when the plan requires them. " +
  "(3) Run the verification commands from the plan exactly once (tests, formatter, linter); on failure fix only the failing issue and run once more; if it still fails STOP and report the blocker. Tick the completed task in the plan file only after its acceptance criterion is verified. " +
  "(4) Stop after the task with a compact checkpoint: active branch, files touched, verification results, tasks ticked. Do NOT commit at this stage. " +
  "(5) COMMIT ON ACCEPTANCE: when told the task was ACCEPTED, run git add -A then exactly ONE commit on the active branch, concise English message fix(scope): summary, never --amend, never push, never task indices. Reply with only the commit hash. " +
  "Guardrails: never run git reset, git checkout --, git restore, git revert, git stash, git clean, git rebase, rm, mv or any destructive operation - fix forward only. Never push in any form. Never add, remove or renumber tasks in the plan. Never work for long stretches: one task, one checkpoint. " +
  "Si un contrôle est impossible à passer ou si les instructions se contredisent, escalade et dis-le clairement plutôt que de bricoler.";

const revalidatorChecklists: Record<string, string> = {
  architecture:
    "Architecture lens: coupling/cohesion, duplication and dead code, layering, error handling, tests next to modules, naming. Also check the diff for over-engineering: reinvented stdlib, speculative abstractions, dead flexibility.",
  performance:
    "Performance lens: complexity on hot paths, N+1 and unbounded data access, allocations in loops, caching correctness, concurrency, sync I/O. Also check the diff for over-engineering.",
  security:
    "Security lens: input validation and injection, auth/session, secrets, dependencies, least privilege. Verify the fix actually closes the finding, not just the symptom.",
};

phase("Corriger, revalider et commiter tâche par tâche");
const outcomes: TaskOutcome[] = [];
let quotaHit = false;
for (const task of tasks) {
  const impl = agent(`implementeur-${task.id}`, { system: implementerPersona });
  const rev = agent(`revalidateur-${task.id}`, {
    system:
      `You are the ${auditType} auditor revalidating ONE implemented task. Lens: ` +
      (revalidatorChecklists[auditType] ?? "") +
      " Read the plan file and the touched code; verify each acceptance criterion and run the task's validation commands yourself. Never edit any file. " +
      "If a check is impossible to pass, or your instructions contradict each other, escalate and say so plainly rather than working around it.",
  });
  let outcome: TaskOutcome = { id: task.id, status: "blocked", commitHash: "", notes: "" };
  let accepted = false;
  let feedback = "none";
  let attempt = 0;
  while (attempt < maxRounds && !accepted && !quotaHit) {
    attempt += 1;
    let work: ImplCheckpoint;
    try {
      work = await impl.ask<ImplCheckpoint>(
        `Tâche ${task.id} — tentative ${attempt}/${maxRounds}. Plan: ${planPath}. Branche imposée: ${branch}. ` +
          `Tâche: ${task.title}\nDétails: ${task.details}\n` +
          (feedback === "none" ? "" : `Corrections demandées par le revalidateur au tour précédent: ${feedback}\n`) +
          `Applique le protocole: lis le plan, vérifie la branche, implémente CETTE tâche seulement, passe les vérifications, coche la tâche dans le plan, rends ton checkpoint. NE commite PAS.`,
      );
    } catch (error) {
      const err = error as { code?: string; message?: string; providerStop?: { kind?: string; resetAt?: string } };
      if (err.code === "ProviderStop" && err.providerStop?.kind === "quota") {
        quotaHit = true;
        outcome = { id: task.id, status: "quota_exhausted", commitHash: "", notes: err.message ?? "quota" };
        report({ event: "quota_epuise", tache: task.id, resetAt: err.providerStop.resetAt ?? "" });
        break;
      }
      throw error;
    }
    const branchCheck = await world.run("git", ["branch", "--show-current"]);
    if (branchCheck.stdout.trim() !== branch) {
      outcome = {
        id: task.id,
        status: "blocked",
        commitHash: "",
        notes: `Garde-fou: branche active '${branchCheck.stdout.trim()}' différente de la branche imposée '${branch}'.`,
      };
      report({ event: "tache_bloquee", id: task.id, raison: outcome.notes });
      break;
    }
    let review: ReviewVerdict;
    try {
      review = await rev.ask<ReviewVerdict>(
        `Revalide la tâche ${task.id} du plan ${planPath} sur la branche ${branch}. Checkpoint de l'implémenteur: ${JSON.stringify(work)}. ` +
          `Vérifie chaque critère d'acceptation et les commandes de validation, puis retourne verdict="ACCEPTED" ou "REJECTED" avec notes précises.`,
      );
    } catch (error) {
      const err = error as { code?: string; message?: string; providerStop?: { kind?: string; resetAt?: string } };
      if (err.code === "ProviderStop" && err.providerStop?.kind === "quota") {
        quotaHit = true;
        outcome = { id: task.id, status: "quota_exhausted", commitHash: "", notes: err.message ?? "quota" };
        report({ event: "quota_epuise", tache: task.id, resetAt: err.providerStop.resetAt ?? "" });
        break;
      }
      throw error;
    }
    if (review.verdict === "ACCEPTED") {
      accepted = true;
      const commitReply = await impl.ask<string>(
        "ACCEPTED par le revalidateur. Applique l'étape COMMIT ON ACCEPTANCE: git add -A puis exactement un commit. Réponds avec le hash du commit.",
      );
      const head = await world.run("git", ["rev-parse", "HEAD"]);
      outcome = {
        id: task.id,
        status: "validated_committed",
        commitHash: head.exitCode === 0 ? head.stdout.trim() : "",
        notes: `Validé en ${attempt} tour(s). ${review.notes}`,
      };
      report({ event: "tache_validee", id: task.id, commitHash: outcome.commitHash, reponse_impl: commitReply.slice(0, 200) });
    } else {
      feedback = review.notes;
      outcome = { id: task.id, status: "blocked", commitHash: "", notes: `REJECTED (tour ${attempt}): ${review.notes}` };
    }
  }
  outcomes.push(outcome);
}

const committed = outcomes.filter((o) => o.status === "validated_committed");
return {
  conclusion: quotaHit
    ? `Quota épuisé en cours de correction — ${committed.length}/${tasks.length} tâche(s) validée(s) et commitée(s); le reste est repris après bascule vers le routeur.`
    : `${committed.length}/${tasks.length} tâche(s) validée(s) et commitée(s) sur ${branch}.`,
  outcomes,
  quotaHit,
  verified: [
    "chaque commit confirmé par git rev-parse HEAD exécuté par le script",
    "la branche active vérifiée en code avant chaque revalidation (garde-fou anti-branche-de-base)",
  ],
  notCovered: ["la discussion critique des plans et le refresh inter-phases se font hors workflow"],
};
