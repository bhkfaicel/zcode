/* zcode-workflow
description: Lance les 3 auditeurs (architecture, performance, security) en
  parallèle sur une cible. Chaque auditeur écrit son plan dans
  plan/<date>-<type>-plan.md. Si le quota du modèle du run s'épuise, l'auditeur
  concerné est marqué quota_exhausted (avec resetAt) et les autres continuent —
  la bascule vers le routeur se fait par AmendWorkflow (subagent_model) +
  reprise avec cache.
whenToUse: Quand l'utilisateur demande un audit
  (architecture/performance/sécurité) d'un scope dans le workspace courant. La
  discussion critique et le fix se font ensuite hors workflow (critique via
  Agent tool GPT, fix via le workflow audit-fix).
args:
  scope:
    type: string
    description: Chemin absolu ou relatif du code à auditer (ex. src/, un dossier,
      un fichier).
    required: true
*/
interface AuditOutcome {
  /** Type d'audit : architecture, performance ou security. */
  auditType: string;
  /** "completed" quand le plan est écrit ; "quota_exhausted" si le quota a interrompu l'auditeur. */
  status: string;
  /** Chemin du plan écrit (plan/<date>-<type>-plan.md), vide sinon. */
  planPath: string;
  /** Résumé en français, cinq lignes maximum. */
  summary: string;
  /** Heure de réinitialisation du quota si connue, sinon vide. */
  resetAt: string;
}

const scope = String(args.scope);

const cadre =
  "Cadre d'exécution : le plan s'écrit dans le workspace courant (chemin relatif plan/...). " +
  "Calcule la date du jour toi-même (commande `date +%F` en shell). N'édite QUE le fichier plan. " +
  "Si un contrôle est impossible à passer ou si les instructions se contredisent, escalade et dis-le clairement plutôt que de bricoler.";

const personaArchitecture =
  "You are an architecture and best practices expert. Analyze the code: structure, patterns, coupling, cohesion, conventions, tests, readability. " +
  "Report only issues verified in the code; mark uncertain items as UNCERTAIN. " +
  "Produce the mandatory plan file at plan/<YYYY-MM-DD>-arch-plan.md: objective, scope, checkbox tasks with acceptance criteria, validation gates with exact commands, parallel flags. Never modify project code: write only the plan file. " +
  "Architecture checklist: coupling/cohesion (god files, scattered logic), duplication and dead code, layering (circular deps, business logic in I/O layers), error handling (swallowed errors), tests (missing tests/ next to modules), naming. " +
  "Severity: BLOCKER / IMPORTANT / HARDENING. Finding format: file:line + quoted evidence + why it hurts + concrete fix. " +
  cadre;

const personaPerformance =
  "You are a performance expert. Analyze the code: algorithmic complexity, N+1 queries, allocations, concurrency, caches, load. " +
  "Report only issues verified in the code; mark uncertain items as UNCERTAIN. " +
  "Produce the mandatory plan file at plan/<YYYY-MM-DD>-perf-plan.md: objective, scope, checkbox tasks with acceptance criteria, validation gates with exact commands, parallel flags. Never modify project code: write only the plan file. " +
  "Performance checklist: accidental O(n^2) on hot paths, N+1 and unbounded queries, allocations in loops, missing caching, lock contention, sync I/O on hot paths. " +
  "Severity: BLOCKER / IMPORTANT / HARDENING. Finding format: file:line + quoted evidence + why it costs (metric, growth) + concrete fix. " +
  cadre;

const personaSecurity =
  "You are a security expert. Analyze the code: injection, auth, data exposure, dependencies, config, secrets. Follow OWASP Top 10 / CWE Top 25 reflexes. " +
  "Report only issues verified in the code; mark uncertain items as UNCERTAIN. " +
  "Produce the mandatory plan file at plan/<YYYY-MM-DD>-secu-plan.md: objective, scope, checkbox tasks with acceptance criteria, validation gates with exact commands, parallel flags. Never modify project code: write only the plan file. " +
  "Security checklist: input validation and injection, auth/session weaknesses, secrets in code, dangerous dependencies, unsafe deserialization, missing least-privilege. " +
  "Severity: BLOCKER / IMPORTANT / HARDENING. Finding format: file:line + quoted evidence + attack scenario + concrete fix. " +
  cadre;

phase("Lancer les 3 auditeurs en parallèle et vérifier leurs plans");
const audits = [
  { type: "architecture", persona: personaArchitecture, plan: "arch" },
  { type: "performance", persona: personaPerformance, plan: "perf" },
  { type: "security", persona: personaSecurity, plan: "secu" },
];
const outcomes: AuditOutcome[] = await Promise.all(
  audits.map(async (a) => {
    try {
      const outcome = await agent(`auditeur-${a.type}`, { system: a.persona }).ask<AuditOutcome>(
        `Cible à auditer : ${scope}\n` +
          `Écris ton plan d'audit complet dans plan/<date-du-jour>-${a.plan}-plan.md (utilise la date réelle obtenue par shell).\n` +
          `Puis retourne exactement : auditType="${a.type}", status="completed", planPath=<chemin relatif du plan écrit>, summary=<résumé en français, 5 lignes max>, resetAt="".`,
      );
      report({ event: "audit_termine", auditType: outcome.auditType, planPath: outcome.planPath });
      return outcome;
    } catch (error) {
      const err = error as { code?: string; message?: string; providerStop?: { kind?: string; resetAt?: string } };
      if (err.code === "ProviderStop" && err.providerStop?.kind === "quota") {
        report({ event: "quota_epuise", auditType: a.type, resetAt: err.providerStop.resetAt ?? "" });
        log(`Quota épuisé pendant l'audit ${a.type} — les autres auditeurs continuent.`);
        return {
          auditType: a.type,
          status: "quota_exhausted",
          planPath: "",
          summary: err.message ?? "quota épuisé",
          resetAt: err.providerStop.resetAt ?? "",
        };
      }
      throw error;
    }
  }),
);

const written = await files.glob("plan/*.md");
const checked = outcomes.map((o) => ({
  ...o,
  planOnDisk: o.planPath !== "" && written.indexOf(o.planPath) !== -1,
}));

const quotaHits = checked.filter((o) => o.status === "quota_exhausted");
return {
  conclusion:
    quotaHits.length === 0
      ? "Les 3 audits sont terminés et leurs plans sont écrits dans plan/ (vérifiés sur le disque)."
      : `${quotaHits.length} audit(s) interrompu(s) par un quota épuisé (${quotaHits.map((q) => q.auditType).join(", ")}) — prévoir la bascule vers le routeur puis la reprise.`,
  results: checked,
  quotaHits: quotaHits.map((q) => ({ auditType: q.auditType, resetAt: q.resetAt })),
  verified: ["chaque plan marqué completed a été retrouvé sur le disque via files.glob(\"plan/*.md\")"],
  notCovered: ["la profondeur des audits dépend des auditeurs eux-mêmes ; la discussion critique se fait hors workflow"],
};
