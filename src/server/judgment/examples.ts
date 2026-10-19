import type { LabelId } from '../../shared/taxonomy.ts';

export const policyExamples: Record<LabelId, readonly [string, string]> = {
  'form.tools': [
    'The package ships its own executable CLI and server for inspecting agent sessions; the README gives commands to run them.',
    'The repository supplies SKILL.md task instructions, which an external agent host loads and executes; no owned executable helper is documented.',
  ],
  'form.skills': [
    'The repository ships local reusable task packages with SKILL.md instructions and also preloads its own task skills in its product.',
    'This catalog links to task skills hosted in other repositories but supplies no local or built-in task skill.',
  ],
  'form.extensions': [
    'The owned agent constructor exposes instructions and model settings to configure that agent, even though the main product is a library.',
    'The program has generic document-conversion and OCR plugins but documents no agent plugin, agent settings, or harness configuration.',
  ],
  'form.workflows': [
    'This library builds agents and defines their task stages, tool-use loop and coordination; it is an agent-building SDK.',
    'This SDK implements only a communication protocol with client/server transports and schemas; no agent task workflow, orchestration or agent-building implementation is supplied.',
  ],
  'form.catalogs': [
    'The main repository content curates third-party agent tools, guides and reference resources with descriptions and links.',
    'This is an owned agent product with its installation instructions and API documentation; primary resource curation is not documented.',
  ],
  'purpose.development': [
    'The program builds websites from user content and provides local preview and deployment operations. Agent relevance is a separate question.',
    'The project is implemented in code and runs its own CI, but its user-facing function is interview coaching with no development or operations task.',
  ],
  'purpose.office': [
    'An optional component drafts project documents and relays team messages, although the main product is developer infrastructure.',
    'The README and license describe the product itself; the actual deliverables have no document, productivity, career, accessibility, customer support, communication or coordination use.',
  ],
  'purpose.content': [
    'The repository supplies its own writer-agent example that composes creative poems from user requests; the main product can still be a developer library.',
    'A coding workflow produces only PRDs, technical specifications and implementation plans. The product README contains promotional illustrations.',
  ],
  'purpose.research': [
    'An actual example supplied with this framework uses agents for scientific analysis of experimental data; it is not merely a description of agents in general.',
    'The repository publishes its own research paper and product benchmark scores but documents no analysis, research, investigation or data-visualization user task.',
  ],
  'purpose.learning': [
    'These actual supplied examples are explicitly offered as educational reference material to teach people design patterns. A curated note-management resource also organizes reusable user knowledge.',
    'The product links to getting-started and API documentation and has an unexplained Workshop heading; no actual human educational material or user knowledge-organization use is described.',
  ],
  'capability.orchestration': [
    'The supplied task skill describes collecting inputs, coordinating specialist agents, checking their results and continuing to the next task stage.',
    'The repository claims its prompts automate work and gives installation steps, but documents no concrete progression, continuation, coordination or application-action mechanism.',
  ],
  'capability.memory': [
    'An owned agent loop receives message history and user context, updates that context and passes both to the next agent at handoff; it has no persistent memory between runs.',
    'A career-advice skill searches job openings and imports a resume only as steps of that career task; it supplies no agent context manager or knowledge-source retrieval component.',
  ],
  'capability.evaluation': [
    'A learning resource provides automated evaluation of agents on tasks and a leaderboard of their performance; the measured subject is agent behavior.',
    'A coding skill reviews generated code, tests a website and checks accessibility. These checks measure task artifacts rather than the agent or its execution.',
  ],
  'capability.runtime': [
    'The repository ships a CLI which installs its agent-connected server in a harness configuration and launches that server using the supported transport.',
    'The README tells users to copy skill files or invoke the external host marketplace; no owned installer, adapter, provider control or runtime manager is documented.',
  ],
  'capability.interaction': [
    'An owned task skill imports profile data from an external application through a third-party gateway, although it does not implement that gateway backend.',
    'The skill is installed and invoked through an agent host or its API; that host usage alone does not add an interface feature or application connection.',
  ],
};
