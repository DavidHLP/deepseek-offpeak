import QtQuick
import qs.Ui
import qs.Commons

// Popup for the DeepSeek bar widget.
//
// Reading order is the answer order: which state we are in, how long is left,
// and exactly when it changes in both zones. Everything below that — the day
// timeline, the balance, the notification switch — is detail you look at only
// when the countdown is not the answer.
//
// The panel holds no schedule state of its own: it renders the service, which
// is the single clock the bar and the CLI read too.
//
// Every row lays out with anchors rather than hand-computed widths in a Row.
// A Row's manual width arithmetic has to account for its own inter-item
// spacing, and getting that wrong overflows the value it was sizing — which is
// exactly how the balance total first rendered as "0.7" instead of "0.71".
Panel {
  id: root
  moduleName: "deepseek-offpeak"

  property var anchorItem: null
  property var hostWidget: null
  readonly property var barIdentity: hostWidget || root

  readonly property var service: bar && bar.shell ? bar.shell.serviceFor("deepseek-offpeak") : null

  readonly property bool peak: service ? service.peak : false
  readonly property string phaseLabel: service ? service.phaseLabel : "Loading"
  readonly property color phaseColor: root.peak ? Color.urgent : Color.accent

  readonly property var balances: service ? service.balanceBalances : []
  readonly property string balanceMessage: service ? service.balanceMessage : ""
  readonly property bool balanceBusy: service ? service.balanceBusy : false
  readonly property bool balanceLoading: service ? service.balanceStatus === "loading" : false

  // Guarded so the panel renders before the bar injects itself.
  readonly property color contentForeground: bar ? bar.foreground : Color.foreground
  readonly property string contentFontFamily: bar ? bar.fontFamily : Style.font.family
  readonly property color dim: Qt.darker(root.contentForeground, 1.4)
  readonly property color faint: Qt.rgba(root.contentForeground.r, root.contentForeground.g,
    root.contentForeground.b, 0.12)

  property bool timelineExpanded: false

  // Keyboard cursor over the panel's three controls, so a summoned panel is
  // usable without the mouse. Hovering a row moves the cursor to it, so there
  // is one highlight at a time either way.
  property int cursor: 0
  readonly property int cursorCount: 3

  function open() { root.controller.show() }
  function close() { root.controller.hide() }
  function toggle() { if (root.opened) root.close(); else root.open() }

  function switchPanel(direction) {
    if (root.bar && typeof root.bar.switchPanelFrom === "function")
      return root.bar.switchPanelFrom(root.barIdentity, direction)
    return false
  }

  function moveCursor(dy) {
    if (dy === 0) return
    root.cursor = (root.cursor + dy + root.cursorCount) % root.cursorCount
  }

  function activateCursor() {
    if (root.cursor === 0) root.timelineExpanded = !root.timelineExpanded
    else if (root.cursor === 1 && root.service) root.service.refreshBalance()
    else if (root.cursor === 2 && root.service) root.service.setNotificationsEnabled(!root.service.notificationsEnabled)
  }

  function scrollBy(dy) {
    if (!panelScroll || panelScroll.contentHeight <= panelScroll.height) return
    panelScroll.contentY = Math.max(0, Math.min(panelScroll.contentHeight - panelScroll.height, panelScroll.contentY + dy))
  }

  function refreshAll() {
    if (root.service) root.service.refresh()
  }

  // One row per currency, with the two components the API actually reports.
  // DeepSeek publishes no token quota and no reset time, so none is invented.
  //
  // An Item holding two anchored lines, not a Column: a Column refuses to lay
  // out children that set top/bottom/verticalCenter anchors, and silently
  // renders nothing — which is how this row first went missing entirely.
  component BalanceRow: Item {
    id: row
    required property var modelData

    width: parent ? parent.width : 0
    implicitHeight: totalText.implicitHeight + Style.space(1) + detailText.implicitHeight

    Text {
      id: currencyText
      textFormat: Text.PlainText
      anchors.left: parent.left
      anchors.right: totalText.left
      anchors.rightMargin: Style.space(8)
      anchors.top: parent.top
      text: String(row.modelData.currency || "")
      color: root.dim
      font.family: root.contentFontFamily
      font.pixelSize: Style.font.body
      font.bold: true
      elide: Text.ElideRight
    }

    Text {
      id: totalText
      textFormat: Text.PlainText
      anchors.right: parent.right
      anchors.top: parent.top
      text: String(row.modelData.totalBalance || "0")
      color: root.contentForeground
      font.family: root.contentFontFamily
      font.pixelSize: Style.font.body
      font.bold: true
    }

    Text {
      id: detailText
      textFormat: Text.PlainText
      anchors.left: parent.left
      anchors.right: parent.right
      anchors.top: totalText.bottom
      anchors.topMargin: Style.space(1)
      text: "granted " + String(row.modelData.grantedBalance || "0")
        + " \u00b7 topped up " + String(row.modelData.toppedUpBalance || "0")
      color: root.dim
      font.family: root.contentFontFamily
      font.pixelSize: Style.font.caption
      elide: Text.ElideRight
    }
  }

  // Label on the left, value on the right, both elided into the width the
  // panel actually got — the narrow-panel answer for a two-column fact.
  component InfoRow: Item {
    id: row
    property string label: ""
    property string value: ""

    width: parent ? parent.width : 0
    implicitHeight: Math.max(labelText.implicitHeight, valueText.implicitHeight)

    Text {
      id: labelText
      textFormat: Text.PlainText
      anchors.left: parent.left
      anchors.right: valueText.left
      anchors.rightMargin: Style.space(8)
      anchors.verticalCenter: parent.verticalCenter
      text: row.label
      color: root.contentForeground
      font.family: root.contentFontFamily
      font.pixelSize: Style.font.bodySmall
      elide: Text.ElideRight
    }

    Text {
      id: valueText
      textFormat: Text.PlainText
      anchors.right: parent.right
      anchors.verticalCenter: parent.verticalCenter
      width: Math.min(implicitWidth, Math.max(0, parent.width * 0.6))
      text: row.value
      color: root.dim
      font.family: root.contentFontFamily
      font.pixelSize: Style.font.bodySmall
      horizontalAlignment: Text.AlignRight
      elide: Text.ElideRight
    }
  }

  // A panel row that is also a keyboard cursor target, optionally carrying a
  // trailing control (the balance refresh button, the notification switch).
  // The label elides against the trailing group; nothing is hand-measured.
  component ActionRow: BorderSurface {
    id: row
    property int cursorIndex: -1
    property string label: ""
    property string hint: ""
    property bool showChevron: false
    property bool expanded: false
    property Component trailingControl: null

    readonly property bool hot: mouse.containsMouse || root.cursor === row.cursorIndex

    signal activated()

    width: parent ? parent.width : 0
    implicitHeight: rowContentHeight
    readonly property real rowContentHeight: Math.max(labelText.implicitHeight,
      Math.max(hintText.implicitHeight, Style.space(22))) + Style.space(8) * 2
    radius: Style.cornerRadius
    color: row.hot ? Style.hoverFillFor(root.contentForeground, Color.accent) : "transparent"
    borderSpec: row.hot
      ? Border.controlSpec("hover-cursor", root.contentForeground, Color.accent)
      : Border.none()

    MouseArea {
      id: mouse
      anchors.fill: parent
      hoverEnabled: true
      cursorShape: Qt.PointingHandCursor
      onEntered: if (row.cursorIndex >= 0) root.cursor = row.cursorIndex
      onClicked: row.activated()
    }

    Text {
      id: labelText
      textFormat: Text.PlainText
      anchors.left: parent.left
      anchors.leftMargin: Style.space(8)
      anchors.right: rightGroup.left
      anchors.rightMargin: Style.space(8)
      anchors.verticalCenter: parent.verticalCenter
      text: row.label
      color: root.contentForeground
      font.family: root.contentFontFamily
      font.pixelSize: Style.font.body
      elide: Text.ElideRight
    }

    Row {
      id: rightGroup
      anchors.right: tailSlot.left
      anchors.rightMargin: tailSlot.width > 0 ? Style.space(8) : 0
      anchors.verticalCenter: parent.verticalCenter
      spacing: Style.space(6)

      Text {
        id: hintText
        textFormat: Text.PlainText
        anchors.verticalCenter: parent.verticalCenter
        visible: row.hint !== ""
        text: row.hint
        color: row.hot ? root.contentForeground : root.dim
        font.family: root.contentFontFamily
        font.pixelSize: Style.font.bodySmall
      }

      Text {
        id: chevronText
        visible: row.showChevron
        anchors.verticalCenter: parent.verticalCenter
        text: row.expanded ? "\uF0143" : "\uF0140"
        color: row.hot ? root.contentForeground : root.dim
        font.family: root.contentFontFamily
        font.pixelSize: Style.font.bodySmall
      }
    }

    // Trailing control slot. Zero-width when nothing was loaded into it, so
    // the label gets the full row rather than a reserved gap.
    Item {
      id: tailSlot
      anchors.right: parent.right
      anchors.rightMargin: Style.space(8)
      anchors.verticalCenter: parent.verticalCenter
      width: tailLoader.item ? tailLoader.item.width : 0
      height: tailLoader.item ? tailLoader.item.height : 0

      Loader {
        id: tailLoader
        anchors.right: parent.right
        anchors.verticalCenter: parent.verticalCenter
        sourceComponent: row.trailingControl
      }
    }

  }

  KeyboardPanel {
    id: panel
    anchorItem: root.anchorItem
    owner: root.barIdentity
    bar: root.bar
    open: root.opened
    focusTarget: keyCatcher
    contentWidth: panel.fittedContentWidth(Style.space(360))
    contentHeight: panel.fittedContentHeight(panelColumn.implicitHeight, Style.space(560))

    PanelKeyCatcher {
      id: keyCatcher
      anchors.fill: parent
      onMoveRequested: function(dx, dy) {
        if (dy !== 0) root.moveCursor(dy)
        if (dx !== 0) root.scrollBy(dx * Style.space(24))
      }
      onActivateRequested: root.activateCursor()
      onCloseRequested: root.close()
      onTabRequested: function(direction) { root.switchPanel(direction) }
      onTextKey: function(t) {
        if (t === "r" || t === "R") root.refreshAll()
        else if (t === "e" || t === "E") root.timelineExpanded = !root.timelineExpanded
      }

      Flickable {
        id: panelScroll
        anchors.fill: parent
        contentWidth: width
        contentHeight: panelColumn.implicitHeight
        clip: true
        boundsBehavior: Flickable.StopAtBounds
        interactive: contentHeight > height

        Column {
          id: panelColumn
          width: panelScroll.width
          spacing: Style.space(10)

          // ---- Which state we are in. The badge says nothing the countdown
          //      below does not, so the hero carries no second summary line.
          PanelHero {
            width: parent.width
            title: "DeepSeek"
            detail: root.phaseLabel.toUpperCase()
            foreground: root.contentForeground
            fontFamily: root.contentFontFamily
            iconComponent: Component {
              Image {
                width: Style.font.display
                height: Style.font.display
                source: Qt.resolvedUrl("assets/deepseek.svg")
                fillMode: Image.PreserveAspectFit
                smooth: true
              }
            }
          }

          // ---- Time left, and what it is counting down to ---------------
          Column {
            width: parent.width
            spacing: Style.space(2)

            Text {
              textFormat: Text.PlainText
              width: parent.width
              text: root.service ? root.service.remainingClock : "\u2014"
              color: root.phaseColor
              font.family: root.contentFontFamily
              font.pixelSize: Style.font.displayLarge
              font.bold: true
              elide: Text.ElideRight
            }

            Text {
              textFormat: Text.PlainText
              width: parent.width
              text: root.service ? root.service.nextSwitchLabel.toUpperCase() : ""
              color: root.dim
              font.family: root.contentFontFamily
              font.pixelSize: Style.font.caption
              font.bold: true
              font.letterSpacing: 1.2
              elide: Text.ElideRight
            }
          }

          // The next change in both zones: the timetable is published in UTC,
          // the day is lived in local time, and the reader should not have to
          // do the subtraction to know when it lands.
          Row {
            width: parent.width
            spacing: Style.space(14)

            Column {
              width: Math.max(0, (parent.width - Style.space(14)) / 2)
              spacing: Style.space(1)

              Text {
                textFormat: Text.PlainText
                width: parent.width
                text: "LOCAL"
                color: root.dim
                font.family: root.contentFontFamily
                font.pixelSize: Style.font.caption
                font.bold: true
                font.letterSpacing: 1.2
              }

              Text {
                textFormat: Text.PlainText
                width: parent.width
                text: root.service ? root.service.nextSwitchLocal : "\u2014"
                color: root.contentForeground
                font.family: root.contentFontFamily
                font.pixelSize: Style.font.heading
                elide: Text.ElideRight
              }

              Text {
                textFormat: Text.PlainText
                width: parent.width
                text: root.service ? root.service.nextSwitchLocalDay : ""
                color: root.dim
                font.family: root.contentFontFamily
                font.pixelSize: Style.font.caption
                elide: Text.ElideRight
              }
            }

            Column {
              width: Math.max(0, (parent.width - Style.space(14)) / 2)
              spacing: Style.space(1)

              Text {
                textFormat: Text.PlainText
                width: parent.width
                text: "UTC"
                color: root.dim
                font.family: root.contentFontFamily
                font.pixelSize: Style.font.caption
                font.bold: true
                font.letterSpacing: 1.2
              }

              Text {
                textFormat: Text.PlainText
                width: parent.width
                text: root.service ? root.service.nextSwitchUtc : "\u2014"
                color: root.contentForeground
                font.family: root.contentFontFamily
                font.pixelSize: Style.font.heading
                elide: Text.ElideRight
              }

              Text {
                textFormat: Text.PlainText
                width: parent.width
                text: root.service ? root.service.nextSwitchUtcDay : ""
                color: root.dim
                font.family: root.contentFontFamily
                font.pixelSize: Style.font.caption
                elide: Text.ElideRight
              }
            }
          }

          Text {
            textFormat: Text.PlainText
            width: parent.width
            text: root.service ? root.service.localOffsetLabel : ""
            color: root.dim
            font.family: root.contentFontFamily
            font.pixelSize: Style.font.caption
            elide: Text.ElideRight
          }

          PanelSeparator { foreground: root.contentForeground }

          // ---- The whole day at a glance --------------------------------
          Column {
            width: parent.width
            spacing: Style.space(6)

            ActionRow {
              cursorIndex: 0
              label: "Day timeline"
              hint: root.timelineExpanded ? "hide" : "show"
              showChevron: true
              expanded: root.timelineExpanded
              onActivated: root.timelineExpanded = !root.timelineExpanded
            }

            // Proportional bar: a peak window is as wide as it is long, so the
            // shape of the day reads without counting labels. Segments are
            // placed by absolute fraction so no seam opens between them.
            Item {
              width: parent.width
              height: Style.space(10)

              Repeater {
                model: root.service ? root.service.daySegmentLayout : []

                Rectangle {
                  required property var modelData
                  x: Math.round(parent.width * modelData.startFrac)
                  width: Math.max(1, Math.round(parent.width * modelData.endFrac) - x)
                  height: parent.height
                  color: modelData.peak ? root.phaseColor : root.faint
                }
              }

              // "Now" marker, drawn over the segments.
              Rectangle {
                visible: root.service !== null
                width: Style.space(2)
                height: parent.height + Style.space(4)
                y: -Style.space(2)
                x: Math.max(0, Math.min(parent.width - width,
                  Math.round(parent.width * (root.service ? root.service.nowFrac : 0))))
                color: root.contentForeground
                radius: 1
              }
            }

            Row {
              width: parent.width
              spacing: Style.space(6)

              Text {
                textFormat: Text.PlainText
                anchors.verticalCenter: parent.verticalCenter
                text: "\u25a0"
                color: root.phaseColor
                font.family: root.contentFontFamily
                font.pixelSize: Style.font.caption
              }

              Text {
                textFormat: Text.PlainText
                anchors.verticalCenter: parent.verticalCenter
                text: "peak"
                color: root.dim
                font.family: root.contentFontFamily
                font.pixelSize: Style.font.caption
              }

              Text {
                textFormat: Text.PlainText
                anchors.verticalCenter: parent.verticalCenter
                leftPadding: Style.space(6)
                text: "\u25a0"
                color: Qt.rgba(root.contentForeground.r, root.contentForeground.g,
                  root.contentForeground.b, 0.35)
                font.family: root.contentFontFamily
                font.pixelSize: Style.font.caption
              }

              Text {
                textFormat: Text.PlainText
                anchors.verticalCenter: parent.verticalCenter
                text: "off-peak"
                color: root.dim
                font.family: root.contentFontFamily
                font.pixelSize: Style.font.caption
              }
            }

            Text {
              textFormat: Text.PlainText
              width: parent.width
              text: root.service ? root.service.timelineDayLabel : ""
              color: root.dim
              font.family: root.contentFontFamily
              font.pixelSize: Style.font.caption
              elide: Text.ElideRight
            }

            Column {
              width: parent.width
              visible: root.timelineExpanded
              spacing: Style.space(2)

              Text {
                textFormat: Text.PlainText
                width: parent.width
                topPadding: Style.space(4)
                text: "PEAK TODAY"
                color: root.dim
                font.family: root.contentFontFamily
                font.pixelSize: Style.font.caption
                font.bold: true
                font.letterSpacing: 1.2
              }

              Text {
                textFormat: Text.PlainText
                width: parent.width
                visible: (root.service ? root.service.todayPeakLabels : []).length === 0
                text: "None \u2014 off-peak all day"
                color: root.contentForeground
                font.family: root.contentFontFamily
                font.pixelSize: Style.font.bodySmall
                elide: Text.ElideRight
              }

              Repeater {
                model: root.service ? root.service.todayPeakLabels : []

                InfoRow {
                  required property var modelData
                  label: modelData.localLabel + " local"
                  value: modelData.utcLabel + " UTC"
                }
              }

              Text {
                textFormat: Text.PlainText
                topPadding: Style.space(4)
                width: parent.width
                text: root.service ? root.service.scheduleSummary : ""
                color: root.dim
                font.family: root.contentFontFamily
                font.pixelSize: Style.font.caption
                wrapMode: Text.WordWrap
              }
            }
          }

          PanelSeparator { foreground: root.contentForeground }

          // ---- Balance. Optional and independent: the schedule above stays
          //      correct when this section cannot load.
          Column {
            width: parent.width
            spacing: Style.space(6)

            ActionRow {
              cursorIndex: 1
              label: "Balance"
              hint: root.balanceLoading ? "loading" : (root.service ? root.service.balanceUpdatedLabel : "")
              onActivated: if (root.service) root.service.refreshBalance()

              trailingControl: Component {
                PanelActionButton {
                  iconText: "\uF0450"
                  tooltipText: "Re-read the account balance"
                  foreground: root.contentForeground
                  hasCursor: root.cursor === 1
                  enabled: !root.balanceLoading
                  onClicked: if (root.service) root.service.refreshBalance()
                }
              }
            }

            Column {
              width: parent.width
              spacing: Style.space(6)
              visible: root.balances.length > 0

              Repeater {
                model: root.balances
                BalanceRow {}
              }
            }

            Text {
              textFormat: Text.PlainText
              width: parent.width
              visible: root.balanceMessage !== ""
              text: root.balanceMessage
              color: root.dim
              font.family: root.contentFontFamily
              font.pixelSize: Style.font.bodySmall
              wrapMode: Text.WordWrap
            }
          }

          PanelSeparator { foreground: root.contentForeground }

          // ---- Notifications --------------------------------------------
          Column {
            width: parent.width
            spacing: Style.space(4)

            ActionRow {
              cursorIndex: 2
              label: "Notify when off-peak starts"
              onActivated: if (root.service) root.service.setNotificationsEnabled(!root.service.notificationsEnabled)

              trailingControl: Component {
                ToggleSwitch {
                  checked: root.service ? root.service.notificationsEnabled : true
                  interactive: false
                  hasCursor: root.cursor === 2
                  foreground: root.contentForeground
                  accent: Color.accent
                }
              }
            }

            Text {
              textFormat: Text.PlainText
              width: parent.width
              text: "Not saved: the switch resets when the shell restarts."
              color: root.dim
              font.family: root.contentFontFamily
              font.pixelSize: Style.font.caption
              wrapMode: Text.WordWrap
            }
          }
        }
      }
    }
  }
}
