// Module definition. Core validates it before composing the plugin: the ID, contract and table prefix must match
// package.json, every table must start with the prefix, every API route lives under /admin, /public or /module-setup
// followed by the module ID, and every table is either backed up or declared non-portable.
// It imports nothing, so the plugin's own unit tests can read it without a Core checkout.
const manifest = {
  id: "example-module",
  label: "Example Module",
  description: "A minimal LancerLogin module plugin that keeps a list of notes.",
  contractVersion: 1,
  available: true,
  dependencies: [],
  // Operators may use the workspace once an Administrator grants them this capability.
  capabilities: [{ id: "example-module.manage", label: "Manage Example Module notes", operator: true }],
  navigation: [{ label: "Example Module", path: "/example-module" }],
  settings: [{ label: "Example Module", path: "/settings/example-module" }],
  // No guided setup: the workspace is ready as soon as an Administrator enables the module.
  setup: { version: 1, steps: [] },
  jobs: [],
  discordCommands: [],
  apiRoutes: [{ path: "/admin/example-module", match: "prefix", access: "workspace" }],
  tablePrefix: "example_module_",
  persistence: { tables: ["example_module_notes"], sharedFields: [], transientAuthority: [] },
  backup: { version: 1, tables: ["example_module_notes"] },
  lifecycle: { cleanupTargets: ["example_module_notes", "platform_module_assignments:example-module"] },
  deletedData: ["Example Module notes"],
} as const;

export default manifest;
