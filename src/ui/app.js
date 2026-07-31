function dashboard() {
  return Object.assign(
    dashboardCore(), dashboardOverview(), dashboardMap(), dashboardAvailability(), dashboardCompare(),
    dashboardServers(), dashboardFirewallsVnets(), dashboardSshKeys(), dashboardHosts(), dashboardMonitoring(),
    dashboardMonitoringView(),
    dashboardFirewall(), dashboardBench(), dashboardBenchCard(), dashboardBenchCompareCard(), dashboardModals(), dashboardNotify(),
    dashboardWatchers(), dashboardCredentials(), dashboardApps(), dashboardAppsDomainPicker(), dashboardAgentControl(),
    dashboardAgentClients(), dashboardAgentActivity(), dashboardAgentAudit(), dashboardRemote(), dashboardVault(),
    dashboardSettings(),
  );
}
