// Dashboard contribution. It imports only the module SDK, React and the plugin's own files; the composed dashboard
// provides one shared copy of each. Core renders every page, the setup screen and the public pages inside the module
// root that scopes visits.css.
import { defineDashboardModule } from "@lancerlogin/module-sdk/dashboard";
import { GuestVisitsPublicPage } from "./dashboard/visits-public";
import { VisitsSettingsPage } from "./dashboard/visits-settings";
import { VisitsSetup } from "./dashboard/visits-setup";
import { VisitsWorkspace } from "./dashboard/visits-workspace";
// Imported after the components so Guest Visits rules follow the Core stylesheets those components load.
import "./visits.css";

const dashboard = defineDashboardModule({
  moduleId: "visits",
  routes: [{ path: "/visits", wide: true, render: ({ role }) => <VisitsWorkspace role={role} /> }],
  settingsPages: [{ path: "/settings/visits", render: ({ openSetup }) => <VisitsSettingsPage openSetup={openSetup} /> }],
  // Guided setup for the manifest's two steps: a working test email and the first availability.
  setup: VisitsSetup,
  // /visit is the booking page and /visit/manage the page the confirmation email links to.
  publicPages: [{ path: "/visit", skipLinkLabel: "Skip to guest visit details", render: (context) => <GuestVisitsPublicPage {...context} /> }],
});

export default dashboard;
