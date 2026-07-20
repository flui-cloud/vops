function dashboard() {
  return Object.assign(
    dashboardCore(), dashboardOverview(), dashboardMap(), dashboardAvailability(), dashboardCompare(),
    dashboardServers(), dashboardFirewallsVnets(), dashboardSshKeys(), dashboardHosts(), dashboardMonitoring(),
    dashboardFirewall(), dashboardBench(), dashboardBenchCard(), dashboardBenchCompareCard(), dashboardModals(), dashboardNotify(),
    dashboardWatchers(),
  );
}
