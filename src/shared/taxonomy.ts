import type { JudgmentResult } from './contracts.ts';

export const taxonomy = {
  facets: [
    {
      id: 'form',
      displayName: '\u8d44\u6e90\u5f62\u6001',
      name: 'Resource form',
      labels: [
        {
          id: 'tools',
          displayName: '\u5de5\u5177\u4e0e\u5e94\u7528',
          name: 'Tools and applications',
          definition:
            'The supplied text documents at least one executable agent-related program implemented or distributed by this repository: a CLI, application, client, server, service/API or executable utility. Optional programs and executables that test agent components qualify. It documents an actual repository deliverable, not merely a command for an external host or a program generated as a task output. A documented executable helper bundled with an owned agent skill or plugin qualifies; it need not be a standalone application.',
          exclusion:
            'No runnable agent-related program is documented as belonging to this repository. Libraries alone, general utilities without documented agent functionality or an owned agent integration, and external programs linked from a catalog do not qualify. Skill instructions, prompts or templates executed through an external agent host alone do not establish a program shipped by this repository. Calling task skills tools does not establish a runnable program.',
          comparisonQuestion:
            'Using only state.repository as evidence and applying state.rules, which statement describes runnable agent-related programs actually shipped by this repository? Policy illustrations only, not repository evidence: (1) This repository documents runnable shell/Node test programs for its own agent plugin infrastructure: supported, even when the plugin mainly delivers skills and the test programs are not standalone products. (2) An agent task skill tells its host to run tests on a user project, but no runnable helper belonging to this repository is documented: not_supported from those host commands alone.',
        },
        {
          id: 'skills',
          displayName: '\u6280\u80fd',
          name: 'Skills',
          definition:
            'This repository documents its own reusable agent task skills or instruction packages. A local SKILL.md package, a skill bundled with a plugin/product, or explicitly built-in/preloaded skills provisioned by the product qualify; built-in skills need not show their file paths.',
          exclusion:
            'No owned agent task skill is documented. Links to skills in other repositories, general explanations of the skill format, and blank skill-authoring templates do not establish an owned skill.',
          comparisonQuestion:
            "Using only state.repository as evidence and applying state.rules, which statement describes this repository's skills?",
        },
        {
          id: 'extensions',
          displayName: '\u63d2\u4ef6\u4e0e\u914d\u7f6e',
          name: 'Plugins and configuration',
          definition:
            'This repository documents an installable agent plugin or non-skill agent configuration: MCP client launch settings, hooks, slash commands, subagent definitions, harness rules/configuration or interface extensions. Built-in agent profiles and agent-specific launch, prompt or model settings also qualify. A plugin installation/invocation command pointing to this repository or a local plugin directory (for example, claude --plugin-dir ./...) establishes an owned plugin, including one that bundles skills. MCP client configuration supplied inline in this README is a configuration deliverable, even when the configured server belongs to another repository.',
          exclusion:
            'No plugin or non-skill agent configuration is documented. SKILL.md packages, their top-level skill router, and copying skill folders into a skills directory are skill delivery alone. External plugin links or general plugin usage instructions do not establish an owned plugin. Generic product/server/trainer settings alone are not agent configuration. General document-conversion or OCR plugins without agent-plugin or harness-configuration functionality do not qualify.',
          comparisonQuestion:
            "Using only state.repository as evidence and applying state.rules, which statement describes this repository's plugins and configuration?",
        },
        {
          id: 'workflows',
          displayName: '\u5de5\u4f5c\u6d41\u4e0e\u6846\u67b6',
          name: 'Workflows and frameworks',
          definition:
            'This repository provides an agent task workflow, an agent orchestration framework, or an SDK for building agents. Documentation of any one is sufficient.',
          exclusion:
            'The supplied text documents none of these agent workflows, frameworks or SDKs. Ordinary CI alone does not qualify.',
          comparisonQuestion:
            "Using only state.repository as evidence and applying state.rules, which statement describes this repository's workflows and frameworks?",
        },
        {
          id: 'catalogs',
          displayName: '\u5408\u96c6\u4e0e\u8d44\u6599',
          name: 'Catalogs and reference',
          definition:
            'This repository is primarily a curated collection of agent resources, reference materials or guides. Its curated entries may be external.',
          exclusion:
            'The supplied text does not establish primary curation of agent resources, references or guides. Merely documenting the use of an owned product does not make it primarily a catalog.',
          comparisonQuestion:
            "Using only state.repository as evidence and applying state.rules, which statement describes this repository's catalogs and reference?",
        },
      ],
    },
    {
      id: 'purpose',
      displayName: '\u4efb\u52a1\u7528\u9014',
      name: 'Task purpose',
      labels: [
        {
          id: 'development',
          displayName: '\u5f00\u53d1\u4e0e\u8fd0\u7ef4',
          name: 'Development and operations',
          definition:
            "This repository's deliverables or actual curated content support software development, testing, deployment, infrastructure operations, system security or designing, building or integrating AI agent applications or their components. Any one documented use is enough. Documented guidance and authoring workflows for these activities qualify; producing final application code is not required.",
          exclusion:
            'No such intended use is documented for the deliverables or actual curated content. Being implemented in code or ordinary repository maintenance alone does not qualify.',
          comparisonQuestion:
            "Using only state.repository as evidence and applying state.rules, which statement describes this repository's development and operations?",
        },
        {
          id: 'office',
          displayName: '\u529e\u516c\u4e0e\u534f\u4f5c',
          name: 'Office and collaboration',
          definition:
            "This repository's deliverables or actual curated content support document handling (creating, editing, parsing or converting documents), personal productivity, job search or career planning, accessibility, customer support, communication or project/team coordination. Documented communication relays and personal-productivity use cases qualify even when the main product is developer infrastructure. Any one documented use is enough; document creation and editing qualify.",
          exclusion:
            'The supplied text documents none of these uses for the deliverables or actual curated content.',
          comparisonQuestion:
            "Using only state.repository as evidence and applying state.rules, which statement describes the documented user tasks of this repository's deliverables or actual curated content?",
        },
        {
          id: 'content',
          displayName: '\u5185\u5bb9\u4e0e\u8425\u9500',
          name: 'Content and marketing',
          definition:
            "The repository's actual deliverables or actual curated content support at least one user purpose: writing, visual design, creative media, business content, or marketing. Visual design includes application UI or graphics. One documented matching feature or creator workflow qualifies even when the main product is developer-facing; a dedicated content product is not required.",
          exclusion:
            "No such user content or marketing purpose is documented. PRDs, technical specifications and implementation plans generated within a coding workflow alone do not qualify. This repository's own documentation, illustrations or promotional material alone do not establish a user content purpose.",
          comparisonQuestion:
            'Using only state.repository as evidence and applying state.rules, which statement describes the user content, writing or design tasks supported by this repository?',
        },
        {
          id: 'research',
          displayName: '\u6570\u636e\u4e0e\u79d1\u7814',
          name: 'Data and research',
          definition:
            'The actual product, supplied skills or actual curated content explicitly support at least one user task: analysis, research, investigation, or information/data visualization. These are alternatives; visualization does not require a research task. Support may be direct or prepare inputs for the task. Text/data analysis, technical/scientific research, debugging and root-cause/security investigation qualify. A built-in research or investigation agent/skill used during development qualifies.',
          exclusion:
            "No such use is attributed to the actual product, supplied skills or curated entries. Introductory examples of what agents or skill formats can do in general, this product's own research paper or benchmark results, and document/spreadsheet handling without a stated analysis, research, investigation or information/data visualization use do not establish this purpose. Artistic design or visual styling alone is not information/data visualization.",
          comparisonQuestion:
            'Using only state.repository as evidence and applying state.rules, which statement describes the analysis, research, investigation or information/data visualization uses of this repository?',
        },
        {
          id: 'learning',
          questionType: 'noul',
          displayName: '\u77e5\u8bc6\u4e0e\u5b66\u4e60',
          name: 'Knowledge and learning',
          definition:
            'At least one actual deliverable or actual curated entry has either purpose: (1) organize or manage reusable user/project knowledge, including user-note management and organizing facts, documents or knowledge bases for reuse; teaching is not required; (2) help people learn, teach or study. Purpose (2) includes courses, study/coaching resources, tools for teaching operations such as classes/rosters/coursework management, skill implementations or reference materials explicitly offered as educational material for people, including examples and design-pattern references, and user documentation/diagram or knowledge-sharing workflows explicitly intended to support organizational learning. These are alternatives: one matching use is sufficient. Actual optional components and curated external resources qualify; a dedicated education product, full curriculum, interface, separate educational component or implementation of external catalog entries is not required.',
          exclusion:
            'Neither knowledge organization nor helping people learn/teach/study is documented for any actual deliverable or actual curated entry. Instructions, methodology or workflow guidance addressed to an agent for coding or other business tasks alone are not educational material for people. Ordinary instructions for installing/using this product and an index of its own documentation alone do not establish either purpose. Ordinary internal data structures alone are not a knowledge-organization use. Generic communication or document rendering without a documented knowledge/learning purpose alone is insufficient. A generic heading or table-of-contents anchor with no description of a matching knowledge-management or people-education use does not establish either purpose.',
          comparisonQuestion:
            'Using only state.repository as evidence and applying state.rules, does any actual deliverable or actual curated entry have a documented user/project knowledge-organization or human learning, teaching or study purpose? Evaluate the actual uses, including optional components and external curated entries; the matching use need not be the main purpose.',
        },
      ],
    },
    {
      id: 'capability',
      displayName: 'agent \u80fd\u529b',
      name: 'Agent capability',
      labels: [
        {
          id: 'orchestration',
          displayName: '\u7f16\u6392\u4e0e\u81ea\u52a8\u5316',
          name: 'Orchestration and automation',
          definition:
            'This repository documents how an owned mechanism advances task stages, continues execution, coordinates agents, or performs actions in another application. A described multi-step task skill or pipeline qualifies; an owned execution engine is not required. Any one documented mechanism is enough, including an optional component.',
          exclusion:
            'No such concrete task-progression, continuation, coordination or application-action mechanism is documented. General claims that skills complete, repeat or automate tasks, task-output names, and plugin installation/activation steps are insufficient. External orchestration or automation projects merely listed here do not qualify.',
          comparisonQuestion:
            "Using only state.repository as evidence and applying state.rules, which statement describes this repository's orchestration and automation?",
        },
        {
          id: 'memory',
          displayName: '\u8bb0\u5fc6\u4e0e\u68c0\u7d22',
          name: 'Memory and retrieval',
          definition:
            "This repository documents an agent memory/context-management mechanism, an owned retrieval-agent example, or a reusable agent component with operations that search or read material from knowledge sources such as documents, wikis, databases, documentation sites or scientific literature. A knowledge-source connector qualifies through those retrieval operations even if it also edits or organizes the source; retrieval need not be the component's sole or main function. An owned retrieval-agent example need not be the main product or a reusable API. A RAG index is not required. A documented owned agent memory/context component qualifies even when optional, experimental, default-off, or backed by an external memory service.",
          exclusion:
            'None of those agent memory/context mechanisms, knowledge-source retrieval components or owned retrieval-agent examples is documented. Search or import within another business task, such as job search or resume import, is insufficient. Task documents, interview stories, skill-context advice and external project links alone do not qualify.',
          comparisonQuestion:
            'Using only state.repository as evidence and applying state.rules, which statement describes the agent memory or knowledge retrieval provided by this repository? Policy illustrations only, not repository evidence: (1) A supplied reusable skill searches and reads pages from a knowledge base or wiki for an agent, through a third-party API: supported. (2) A supplied retrieval-and-reasoning agent example: supported. (3) A career-advice skill searches job openings and imports a resume only within that career task: not_supported. (4) A catalog links to an external memory or document-retrieval project but supplies no own retrieval component: not_supported.',
        },
        {
          id: 'evaluation',
          displayName: '\u8bc4\u6d4b\u4e0e\u89c2\u6d4b',
          name: 'Evaluation and observability',
          definition:
            "This repository provides a mechanism whose measured or observed subject is an AI agent's behavior or execution. Testing or comparing agent behavior, recording/displaying/retrieving execution events or session traces, displaying an agent's running/completed status or issuing notifications based on that status, and tracking agent usage or cost qualify. A bundled tool or skill retrieving agent execution traces qualifies even when the tracing service is external. Manual steps and optional components may qualify; an automatic agent launcher or an owned tracing backend is not required. A supplied terminal or chat renderer that displays agent tool-call events and their execution statuses qualifies; it need not operate the agent. An owned diagnostic skill that reads agent session transcripts and reports what the agent executed or where its behavior failed also qualifies; the transcripts may be stored by the external agent host.",
          exclusion:
            'No such agent-behavior evaluation or execution-observation mechanism is documented. Checking code, websites, accessibility or other task artifacts is not evaluation of the agent itself. Ordinary repository CI, project journals kept as context for later tasks, and environment switching alone do not establish agent evaluation or observation. Product benchmark numbers and external project links alone are insufficient.',
          comparisonQuestion:
            'Using only state.repository as evidence and applying state.rules, which statement describes evaluation or observation of agents provided by this repository? Policy illustrations only, not repository evidence: (1) A coding workflow checks its generated diff against requirements and runs lint, type checks and unit tests: not_supported, because it checks task artifacts. (2) A project journal preserves completed work and context for the next coding session: not_supported. (3) A supplied tool retrieves an agent run tree with model/tool calls, errors and latency from an external tracing service: supported. (4) A benchmark runs or compares agents on tasks to assess their behavior: supported. (5) A bundled diagnostic task skill reads local agent session transcripts and reports execution evidence: supported; reading existing host traces is observation, without an owned recorder or tracing server.',
        },
        {
          id: 'runtime',
          displayName: '\u6a21\u578b\u4e0e\u8fd0\u884c\u7ba1\u7406',
          name: 'Model and runtime management',
          definition:
            'This repository provides mechanisms to install, adapt or distribute agent/harness components, or manage model routing, provider access, permissions, isolation or runtime configuration. Owned installers, generation of harness-specific agent/skill/command configurations with permission mappings, adapters and model proxies/gateways qualify. An owned agent or task-skill runner with model-provider access or inference settings also qualifies. Model or effort selection and reasoning/token budgets exposed by an owned agent service/API are runtime controls.',
          exclusion:
            'No owned agent model/runtime management mechanism is documented. Manually copying skills or using an external host plugin/marketplace command to install this repository skills alone does not establish an owned installer, adapter or runtime manager. Recommending models or linking external runtime components alone does not qualify.',
          comparisonQuestion:
            "Using only state.repository as evidence and applying state.rules, which statement describes this repository's model and runtime management?",
        },
        {
          id: 'interaction',
          displayName: '\u4ea4\u4e92\u4e0e\u96c6\u6210',
          name: 'Interaction and integrations',
          definition:
            'This repository provides agent voice, remote control, notifications, interface enhancements, or an owned component that connects agents to an external application/API. Documented reading, fetching or importing data from an external application qualifies as an integration, as do modifying data or performing other actions there. An owned plugin or task skill qualifies even when it uses an external gateway/service; it need not own the external backend. Owned optional service adapters or executable API-processing examples also qualify. The interaction or connection must be functionality described for the owned component, beyond that component merely being installed, loaded or invoked by an agent host.',
          exclusion:
            'No owned agent interaction or explicit application/API integration is documented. Merely listing external integrations or giving generic task instructions without an explicit integration does not qualify. Installing, loading or invoking task skills through a host, including its API, and generating compatible host task/rule configurations alone do not establish an interface enhancement or external application connection.',
          comparisonQuestion:
            'Using only state.repository as evidence and applying state.rules, which statement describes the agent interaction or external application integrations provided by this repository? Policy illustrations only, not repository evidence: (1) A local document task skill is installed and invoked through its agent host or the host API: not_supported from that host usage alone. (2) An owned task skill imports profile data from an external application through a third-party gateway: supported, even without an owned backend. (3) A workflow installer generates task/rule configurations for compatible agent hosts but provides no additional interface feature or application connection: not_supported. (4) An owned renderer improves the agent interface, or an owned component provides voice/remote control/notifications: supported.',
        },
      ],
    },
  ],
} as const;

export type FacetId = (typeof taxonomy.facets)[number]['id'];
type FullLabel<F> = F extends { id: infer I extends string; labels: readonly { id: string }[] }
  ? `${I}.${F['labels'][number]['id']}`
  : never;
export type LabelId = FullLabel<(typeof taxonomy.facets)[number]>;
export const labels = taxonomy.facets.flatMap((f) =>
  f.labels.map((l) => ({ ...l, id: `${f.id}.${l.id}` as LabelId, facet: f.id })),
);
export const labelIds = labels.map((l) => l.id);
export const RULE_VERSION = 'atlas-38';
export const MODEL = 'typesafe/jev-1.14';
export type Taxonomy = typeof taxonomy;
export const RELEVANT_MIN = 0.8;
export const UNRELATED_MAX = 0.2;
export const LABEL_MIN = 0.52;
export function labelValue(answer: JudgmentResult['decisions'][string]): boolean | null {
  if (answer.needsReview) return null;
  return answer.type === 'noul' ? answer.noul > 0.5 : answer.choice === 'supported';
}
export type FacetState =
  'unjudged' | 'none' | 'pending' | 'partial' | 'confirmed' | 'withheld' | 'historical';
export function labelFacetStates(
  decisions: JudgmentResult['decisions'] | null,
  applied: LabelId[],
  manual: boolean,
  ruleVersion = RULE_VERSION,
): Record<FacetId, FacetState> {
  return Object.fromEntries(
    taxonomy.facets.map((facet) => {
      const selected = applied.some((id) => id.startsWith(facet.id + '.'));
      if (manual) return [facet.id, selected ? 'confirmed' : 'none'];
      if (!decisions) return [facet.id, 'unjudged'];
      if (ruleVersion !== RULE_VERSION) return [facet.id, 'historical'];
      const values = facet.labels.map((label) => {
        const id = `${facet.id}.${label.id}` as LabelId;
        return labelValue(decisions['label.' + id]);
      });
      const uncertain = values.includes(null);
      if (selected) return [facet.id, uncertain ? 'partial' : 'confirmed'];
      if (values.includes(true)) return [facet.id, 'withheld'];
      return [facet.id, uncertain ? 'pending' : 'none'];
    }),
  ) as Record<FacetId, FacetState>;
}
