import QtQuick
import Quickshell.Io
import Quickshell
import "Plugin" as Plugin
import qs.Commons
import qs.Ui as Ui
import qs.Commons as Commons
import "Fixtures.js" as Fixtures
import "Plugin/lib/Schedule.js" as Schedule
import "Plugin/lib/Holidays.js" as Holidays
import "Plugin/lib/Balance.js" as Balance
ShellRoot {
  id: root
  property string scenarioName: "balance"
  property int timeIndex: 0
  property bool light: false
  function theme(value) {
    light = value
    Commons.Color.shellValues = ({})
    Commons.Color.foreground = light ? "#202020" : "#dadada"
    Commons.Color.background = light ? "#eff1f5" : "#17191f"
    Commons.Color.accent = light ? "#3155a0" : "#89b4fa"
    Commons.Color.urgent = light ? "#b02038" : "#ff8095"
  }
  Component.onCompleted: theme(false)
  QtObject {
    id: fixture
    property double nowMs: Fixtures.times[root.timeIndex]
    property var holidays: root.scenarioName === "holidays" ? ({}) : Holidays.fallback()
    property var billing: Schedule.stateAt(nowMs, holidays)
    property bool peak: billing.peak
    property string phaseLabel: peak ? "Peak" : "Off-peak"
    property real secondsToSwitch: billing.secondsToSwitch
    property string remainingClock: Schedule.formatClock(secondsToSwitch)
    property string remainingShort: Schedule.formatShort(secondsToSwitch)
    property string nextSwitchLabel: peak ? "Off-peak starts" : "Peak starts"
    property string nextSwitchLocal: Schedule.hhmmLocal(billing.nextSwitchMs)
    property string nextSwitchUtc: Schedule.hhmmUtc(billing.nextSwitchMs)
    property string nextSwitchLocalDay: Schedule.localDayLabel(billing.nextSwitchMs)
    property string nextSwitchUtcDay: Schedule.utcDayLabel(billing.nextSwitchMs)
    property string localOffsetLabel: Schedule.offsetLabel(nowMs)
    property string holidayYearsLabel: Holidays.yearsOf(holidays).join(", ")
    property string holidayName: Schedule.holidayName(nowMs, holidays)
    property string scheduleSummary: Schedule.scheduleSummary(holidayYearsLabel)
    property var day: Schedule.timeline(nowMs, holidays)
    property var daySegmentLayout: day.layout
    property var todayPeakLabels: day.peaks
    property real nowFrac: day.nowFrac
    property string timelineDayLabel: day.dayLabel
    property var balanceState: Fixtures.balance(root.scenarioName, nowMs)
    property string balanceStatus: balanceState.status
    property var balanceBalances: balanceState.balances
    property string balanceMessage: Balance.describeState(balanceState)
    property bool balanceBusy: balanceStatus === "loading"
    property bool keyReadBusy: false
    property string balanceUpdatedLabel: balanceState.updatedAtMs ? "fixture · " + Schedule.hhmmLocal(balanceState.updatedAtMs) + " local" : ""
    property bool notificationsEnabled: true
    property int refreshCount: 0
    function refreshBalance() { refreshCount++ }
    function refresh() { refreshBalance() }
    function setNotificationsEnabled(value) { notificationsEnabled = value }
    function statusText() { return "SIMULATED " + phaseLabel + " " + remainingClock }
    function statusObject() { return { simulated: true, phase: phaseLabel, remaining: remainingClock } }
  }
  QtObject {
    id: mockBar
    property QtObject shell: QtObject { function serviceFor(name) { return root.scenarioName === "service" ? null : fixture } }
    property color foreground: Commons.Color.foreground
    property string fontFamily: Style.font.family
    property color barForeground: foreground
    property color urgent: Commons.Color.urgent
    property bool vertical: false
    property bool foregroundAnimationEnabled: false
    function hideTooltip(item) {}
    function showTooltip(item, text) { console.log("Preview tooltip:", text) }
    property string position: "top"
    property int barSize: 32
    property var activePopout: null
    function requestPopout(value) { activePopout = value }
    function releasePopout(value) { activePopout = null }
  }
  PanelWindow {
    anchors { top: true; left: true }
    implicitWidth: Math.min(1000, screen ? screen.width : 1000)
    implicitHeight: 72
    color: Commons.Color.background
    Row {
      spacing: Style.space(8)
      Plugin.BarWidget { id: chip; bar: mockBar; width: implicitWidth; height: 40 }
      Ui.WidgetButton { bar: mockBar; text: "Theme: " + (root.light ? "light" : "dark"); onPressed: root.theme(!root.light) }
      Ui.WidgetButton { bar: mockBar; text: "State: " + root.scenarioName; onPressed: root.scenarioName = Fixtures.scenarios[(Fixtures.scenarios.indexOf(root.scenarioName) + 1) % Fixtures.scenarios.length] }
      Ui.WidgetButton { bar: mockBar; text: "Time: " + ["peak", "off-peak", "weekend", "before boundary", "at boundary"][root.timeIndex]; onPressed: root.timeIndex = (root.timeIndex + 1) % Fixtures.times.length }
    }
    Text {
      y: 42
      width: parent.width
      text: "SIMULATED · refreshes: " + fixture.refreshCount + " · notifications: " + fixture.notificationsEnabled + " · no requests or real notices"
      color: Commons.Color.foreground
      font.family: Style.font.family
      font.pixelSize: Style.font.caption
      wrapMode: Text.WordWrap
    }
  }
  IpcHandler {
    target: "preview"
    function scenario(name: string): string {
      if (Fixtures.scenarios.indexOf(name) < 0) return "Unknown scenario: " + Fixtures.scenarios.join(", ")
      root.scenarioName = name
      chip.close(); Qt.callLater(chip.open)
      return "ok"
    }
    function theme(name: string): string {
      if (name !== "light" && name !== "dark") return "Use light or dark"
      root.theme(name === "light")
      return "ok"
    }
  }
}
