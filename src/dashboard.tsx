// Dashboard contribution. It imports only the module SDK and React; the composed dashboard provides one shared copy of
// each. The workspace route matches the manifest's navigation path and the settings page its settings path. The
// Availability, Visits, Needs attention and Guest teams sections and the guest pages build on src/shared.
import { defineDashboardModule } from "@lancerlogin/module-sdk/dashboard";

function GuestVisitsWorkspace() {
  return (
    <section className="ui-card" aria-labelledby="visits-title">
      <h1 id="visits-title">Guest Visits</h1>
      <p>Availability, visits and guest teams will appear here.</p>
    </section>
  );
}

function GuestVisitsSettings() {
  return (
    <section className="ui-card" aria-labelledby="visits-settings-title">
      <h1 id="visits-settings-title">Guest Visits</h1>
      <p>Guest page, email and Discord settings will appear here.</p>
    </section>
  );
}

const dashboard = defineDashboardModule({
  moduleId: "visits",
  routes: [{ path: "/visits", render: () => <GuestVisitsWorkspace /> }],
  settingsPages: [{ path: "/settings/visits", render: () => <GuestVisitsSettings /> }],
});

export default dashboard;
