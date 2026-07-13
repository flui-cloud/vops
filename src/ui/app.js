function dashboard() {
  return Object.assign(
    dashboardCore(), dashboardOverview(), dashboardMap(), dashboardAvailability(),
    dashboardServers(), dashboardFirewallsVnets(), dashboardSshKeys(), dashboardHosts(), dashboardModals(),
    dashboardNotify(),
  );
}
