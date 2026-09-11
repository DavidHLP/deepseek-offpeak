import QtQuick
import Quickshell.Io
import qs.Ui
import qs.Commons
import "lib/Schedule.js" as Schedule

// Bar widget: DeepSeek's current pricing state and the time left in it.
//
// The state and the countdown come from the plugin's service, so the bar, the
// panel, and the CLI all read one clock — none of them computes the schedule
// on its own. Clicking opens the panel; a middle click re-reads the schedule
// and the balance immediately instead of waiting for the next poll.
BarWidget {
  id: root
  moduleName: "deepseek-offpeak"

  readonly property var service: bar && bar.shell ? bar.shell.serviceFor("deepseek-offpeak") : null

  readonly property bool peak: service ? service.peak : false
  readonly property string phaseLabel: service ? service.phaseLabel : "\u2014"
  readonly property string remaining: service ? service.remainingShort : ""
  readonly property real remainingSeconds: service ? service.secondsToSwitch : 0

  readonly property string label: root.remaining.length > 0
    ? root.phaseLabel + " " + root.remaining : root.phaseLabel

  // A vertical bar slot is ~28px wide and drops the widget's text label, so the
  // content is stacked instead — and the state word is included, because a
  // glyph alone is a poorer read of peak-vs-off-peak than the word is. Every
  // line is clipped to the slot: the full "10h 52m" would overflow it, so the
  // countdown drops to its largest unit.
  readonly property var verticalLines: {
    if (!root.vertical) return []
    return [root.peak ? "Peak" : "Off", Schedule.formatCompact(root.remainingSeconds)]
  }

  readonly property string tooltip: service
    ? "DeepSeek " + root.phaseLabel.toLowerCase() + " \u00b7 "
      + service.nextSwitchLabel.toLowerCase() + " " + service.nextSwitchLocal + " local ("
      + service.nextSwitchUtc + " UTC) in " + service.remainingClock
    : "DeepSeek pricing is loading"

  // ---- Panel shape contract for the shell's summon/hide/toggle routing ----
  readonly property bool opened: panelLoader.item ? panelLoader.item.opened === true : false

  function open() { if (panelLoader.item) panelLoader.item.open() }
  function close() { if (panelLoader.item) panelLoader.item.close() }
  function togglePanel() { if (panelLoader.item) panelLoader.item.toggle() }

  readonly property bool popoutSwitchClosing: panelLoader.item ? panelLoader.item.popoutSwitchClosing === true : false

  function closeForPopoutSwitch() {
    if (panelLoader.item) panelLoader.item.closeForPopoutSwitch()
  }

  function injectPanel() {
    var target = panelLoader.item
    if (!target) return
    if ("bar" in target) target.bar = root.bar
    if ("settings" in target) target.settings = root.settings
    if ("anchorItem" in target) target.anchorItem = button
    if ("hostWidget" in target) target.hostWidget = root
  }

  implicitWidth: button.implicitWidth
  implicitHeight: button.implicitHeight

  onBarChanged: injectPanel()
  onSettingsChanged: injectPanel()

  Loader {
    id: panelLoader
    active: true
    source: Qt.resolvedUrl("Panel.qml")
    visible: false
    onLoaded: {
      root.injectPanel()
      Qt.callLater(root.injectPanel)
    }
  }

  // The bar widget owns the plugin's IPC surface — one target, one owner —
  // and delegates to the service, so `status` reads the same clock the bar
  // shows. (An IpcHandler on the service would be a second handler for the
  // same target, which only one of them can serve.)
  IpcHandler {
    target: "deepseek-offpeak"

    function status(): string {
      return root.service ? root.service.statusText() : "DeepSeek Off-Peak service is not running"
    }

    function statusJson(): string {
      return root.service
        ? JSON.stringify(root.service.statusObject(), null, 2)
        : JSON.stringify({ id: "deepseek-offpeak", error: "service_unavailable" }, null, 2)
    }

    function refresh(): string {
      if (!root.service) return "service_unavailable"
      root.service.refresh()
      return "ok"
    }

    function open(): void { root.open() }
    function close(): void { root.close() }
    function show(): void { root.open() }
    function hide(): void { root.close() }
    function toggle(): void { root.togglePanel() }

    function notifications(): string {
      // "off" would report a real setting that was read. A service that is
      // still loading, or that failed to start, is not a disabled toggle —
      // setNotifications() below already answers service_unavailable for that,
      // and this is the same case.
      if (!root.service) return "service_unavailable"
      return root.service.notificationsEnabled ? "on" : "off"
    }

    function setNotifications(value: string): string {
      if (!root.service) return "service_unavailable"
      var v = String(value || "").toLowerCase()
      root.service.setNotificationsEnabled(v === "true" || v === "1" || v === "on" || v === "yes")
      return root.service.notificationsEnabled ? "on" : "off"
    }
  }

  // The bar's open-panel mark tracks what the widget actually paints — the
  // label is a countdown, so it changes length every minute.
  readonly property real openPanelIndicatorWidth: root.vertical ? Style.bar.iconSlot : horizontalContent.implicitWidth
  readonly property real openPanelIndicatorHeight: Math.max(Style.space(10), Math.round(Style.bar.iconSlot * 0.55))

  WidgetButton {
    id: button
    anchors.fill: parent
    bar: root.bar
    labelVisible: false
    hasVisualContent: true
    fixedWidth: root.vertical ? -1 : horizontalContent.implicitWidth + scaledHorizontalMargin * 2
    fixedHeight: root.vertical ? (root.verticalLines.length + 1) * Style.bar.iconSlot : -1
    horizontalMargin: 8.5
    tooltipText: root.tooltip
    // Keep the peak label's warning color alongside the DeepSeek logo.
    active: root.peak
    activeColor: root.bar ? root.bar.urgent : Color.urgent
    onPressed: function(b) {
      if (b === Qt.MiddleButton) {
        if (root.service) root.service.refresh()
        return
      }
      root.togglePanel()
    }

    Row {
      id: horizontalContent
      visible: !root.vertical
      anchors.centerIn: parent
      spacing: Style.space(5)

      Image {
        anchors.verticalCenter: parent.verticalCenter
        width: Style.font.icon
        height: Style.font.icon
        source: Qt.resolvedUrl("assets/deepseek.svg")
        fillMode: Image.PreserveAspectFit
        smooth: true
      }

      Text {
        text: root.label
        color: root.peak ? button.activeColor : button.foreground
        font.family: button.fontFamily
        font.pixelSize: button.fontSize
        renderType: Text.NativeRendering
      }
    }

    Column {
      visible: root.vertical
      anchors.fill: parent

      Image {
        width: button.width
        height: Style.bar.iconSlot
        source: Qt.resolvedUrl("assets/deepseek.svg")
        fillMode: Image.PreserveAspectFit
        smooth: true
      }

      Repeater {
        model: root.verticalLines

        // Text.Fit rather than a guessed per-length size: the slot is ~28px and
        // the theme can scale it, so measuring the string against the slot is
        // the only version that holds for every glyph, unit ("10h", "52m"),
        // font, and [font] base-size. `minimumPixelSize` keeps the result
        // legible instead of shrinking a long string to a smear.
        Text {
          required property string modelData
          width: button.width
          height: Style.bar.iconSlot
          text: modelData
          color: modelData === "Peak" ? button.activeColor : button.foreground
          font.family: button.fontFamily
          font.pixelSize: Style.font.body
          fontSizeMode: Text.Fit
          minimumPixelSize: Style.font.caption
          horizontalAlignment: Text.AlignHCenter
          verticalAlignment: Text.AlignVCenter
        }
      }
    }
  }
}
