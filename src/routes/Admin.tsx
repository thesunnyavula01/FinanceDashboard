import { PhaseStub } from "@/components/terminal/PhaseStub";

export function Admin() {
  return (
    <PhaseStub
      title="Admin console"
      phase={6}
      summary="Club officer controls. Restricted to accounts with the admin role; members who reach this screen will be turned away."
      items={[
        "Create a season and set the starting cash every member begins with",
        "Lock trading during meetings or at the end of the season",
        "Rotate the invite code",
        "Promote a member to admin",
        "Correct or void a bad trade",
      ]}
    />
  );
}
