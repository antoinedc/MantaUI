import SwiftUI
import Charts

// ===========================================================================
// WS09 F3 — the token optimizer dashboard, READ-ONLY (the "Manta optimized token
// usage" switch is a Settings schema setting; nothing here edits it). Every string,
// band and tone comes from the box's `view` blocks (`optimizer:summary.view`,
// `optimizer:series.view`); the phone only draws them — the cumulative line and
// the axis ticks are the one thing it computes (`OptimizerChart`, M8).
// ===========================================================================

@MainActor
final class OptimizerStore: ObservableObject {
    enum SummaryPhase: Equatable {
        case loading
        case loaded(OptimizerSummaryViewWire)
        case needsNewerRuntime
        case updateYourBox
        case failed(String)
    }

    enum SeriesPhase: Equatable {
        case loading
        case loaded(OptimizerSeriesWire, OptimizerSeriesViewWire)
        /// `{supported:false}`: only the chart block says so.
        case needsNewerRuntime
        case updateYourBox
        case failed(String)
    }

    static let ranges = ["24h", "7d", "30d"]

    @Published private(set) var summary: SummaryPhase = .loading
    @Published private(set) var series: SeriesPhase = .loading
    @Published private(set) var range = "24h"
    /// A new range is loading while the previous chart stays on screen (dimmed).
    @Published private(set) var seriesRefreshing = false

    private let api: MantaAPIClient
    private var seriesSeq = 0

    init(api: MantaAPIClient = .live()) {
        self.api = api
    }

    func refresh() async {
        await loadSummary()
        await loadSeries()
    }

    func select(range next: String) async {
        guard next != range, Self.ranges.contains(next) else { return }
        range = next
        await loadSeries()
    }

    private func loadSummary() async {
        do {
            let result = try await api.optimizerSummary()
            if !result.supported {
                summary = .needsNewerRuntime
            } else if let view = result.view {
                summary = .loaded(view)
            } else {
                summary = .updateYourBox
            }
        } catch {
            summary = ModelsCapability.isUnsupported(error) ? .updateYourBox : .failed(ModelsCapability.reason(error))
        }
    }

    private func loadSeries() async {
        seriesSeq += 1
        let seq = seriesSeq
        let wanted = range
        seriesRefreshing = true
        defer { if seq == seriesSeq { seriesRefreshing = false } }
        let next: SeriesPhase
        do {
            let result = try await api.optimizerSeries(range: wanted)
            if !result.supported {
                next = .needsNewerRuntime
            } else if let view = result.view {
                next = .loaded(result, view)
            } else {
                next = .updateYourBox
            }
        } catch {
            next = ModelsCapability.isUnsupported(error) ? .updateYourBox : .failed(ModelsCapability.reason(error))
        }
        // Only the newest request lands: a slow 30d answer never overwrites a later 24h one.
        guard seq == seriesSeq else { return }
        series = next
    }
}

struct OptimizerScreen: View {
    @StateObject private var store = OptimizerStore()
    @Environment(\.colorScheme) private var colorScheme

    private var tokens: Tokens { Tokens.scheme(colorScheme) }

    var body: some View {
        List {
            switch store.summary {
            case .loading:
                Section { ProgressView("Reading your history…") }
            case .needsNewerRuntime:
                Section { Text("Spend history needs a newer box runtime.").foregroundStyle(.secondary) }
            case .updateYourBox:
                Section { Text(ModelsCapability.updateYourBox).foregroundStyle(.secondary) }
            case .failed(let message):
                Section {
                    Text("Couldn't load the optimizer — \(message)").foregroundStyle(.secondary)
                    Button("Retry") { Task { await store.refresh() } }
                }
            case .loaded(let view):
                switchSection(view)
                if !view.windows.isEmpty { windowsSection(view) }
                chartSection(view)
                statsSection(view)
                if !view.metered.isEmpty { meteredSection(view) }
                activitySection(view)
            }
        }
        .navigationTitle("Token optimizer")
        .navigationBarTitleDisplayMode(.inline)
        .refreshable { await store.refresh() }
        .task { await store.refresh() }
    }

    // MARK: - Switch + sub-rows

    private func switchSection(_ view: OptimizerSummaryViewWire) -> some View {
        Section {
            Text(view.switch.body).font(.footnote).foregroundStyle(.secondary)
            if case .loaded(_, let seriesView) = store.series, let trimming = seriesView.trimming {
                subrow(name: trimming.name, text: trimming.text, chip: trimming.chip)
            }
            ForEach(view.subrows) { row in
                subrow(name: row.name, text: row.text, chip: row.chip)
            }
        } header: {
            HStack {
                Text("Manta optimized token usage")
                Spacer()
                Text(view.switch.label)
                    .font(.caption.weight(.semibold))
                    .padding(.horizontal, Metrics.spacing.sp2)
                    .padding(.vertical, 2)
                    .background(view.switch.on ? tokens.accentSoft : tokens.fill, in: Capsule())
                    .foregroundStyle(view.switch.on ? tokens.accentTx : tokens.tx3)
            }
        } footer: {
            Text("Change this in Settings → Models.")
        }
    }

    private func subrow(name: String, text: String, chip: String) -> some View {
        VStack(alignment: .leading, spacing: Metrics.spacing.sp1) {
            HStack {
                Text(name).font(.body.weight(.semibold))
                Spacer()
                Text(chip).font(.caption).foregroundStyle(.secondary)
            }
            Text(text).font(.caption).foregroundStyle(.secondary)
        }
        .accessibilityElement(children: .combine)
    }

    // MARK: - Windows

    private func windowsSection(_ view: OptimizerSummaryViewWire) -> some View {
        Section {
            ForEach(view.windows) { window in
                VStack(alignment: .leading, spacing: Metrics.spacing.sp1) {
                    HStack {
                        Text(window.title).font(.body.weight(.semibold)).lineLimit(1)
                        Spacer()
                        if let resetsAt = window.resetsAt {
                            Text("resets \(UsageMeters.resetAt(Date(timeIntervalSince1970: resetsAt / 1000), now: Date()))")
                                .font(.caption)
                                .foregroundStyle(.secondary)
                        }
                    }
                    OptimizerGauge(pct: window.pct, forecastPct: window.forecastPct, forecastWarn: window.forecastWarn,
                                   fill: bandColor(window.band), tokens: tokens)
                    HStack {
                        Text("\(window.pctLabel) · \(window.forecastLabel)")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                        Spacer()
                        Text(window.pressure.text)
                            .font(.caption.weight(.semibold))
                            .foregroundStyle(toneColor(window.pressure.tone))
                    }
                }
                .accessibilityElement(children: .combine)
            }
        } header: {
            Text("Plan windows")
        } footer: {
            Text(view.windowsCaption)
        }
    }

    // MARK: - Chart

    private func chartSection(_ summary: OptimizerSummaryViewWire) -> some View {
        Section {
            Picker("Range", selection: Binding(
                get: { store.range },
                set: { next in Task { await store.select(range: next) } }
            )) {
                ForEach(OptimizerStore.ranges, id: \.self) { Text($0).tag($0) }
            }
            .pickerStyle(.segmented)

            switch store.series {
            case .loading:
                ProgressView()
            case .needsNewerRuntime:
                Text("Spend history needs a newer box runtime.").foregroundStyle(.secondary)
            case .updateYourBox:
                Text(ModelsCapability.updateYourBox).foregroundStyle(.secondary)
            case .failed(let message):
                Text("Couldn't load the chart — \(message)").foregroundStyle(.secondary)
                Button("Retry") { Task { await store.refresh() } }
            case .loaded(let series, let view):
                loadedChart(series, view)
                    .opacity(store.seriesRefreshing ? 0.6 : 1)
            }
        } header: {
            if case .loaded(_, let view) = store.series { Text(view.heading) } else { Text("Token consumption") }
        }
    }

    @ViewBuilder
    private func loadedChart(_ series: OptimizerSeriesWire, _ view: OptimizerSeriesViewWire) -> some View {
        if view.noActivity {
            Text(view.emptyText).foregroundStyle(.secondary)
        } else {
            let points = series.series ?? []
            if let saving = view.savingLabel {
                Text(saving.text)
                    .font(.footnote.weight(.semibold))
                    .foregroundStyle(toneColor(saving.tone))
                    .frame(maxWidth: .infinity, alignment: .trailing)
            }
            OptimizerChartView(points: points, rawValues: view.hasCounterfactual ? view.rawValues : nil,
                               bucket: series.bucket ?? "hour", tokens: tokens)
                .frame(height: 180)
                .accessibilityLabel("Cumulative tokens sent over \(series.range ?? "the selected range")")
            legend(view)
            if let potential = view.potentialLine {
                Text(potential).font(.caption).foregroundStyle(.secondary)
            }
        }
    }

    private func legend(_ view: OptimizerSeriesViewWire) -> some View {
        VStack(alignment: .leading, spacing: Metrics.spacing.sp1) {
            HStack(spacing: Metrics.spacing.sp2) {
                Capsule().fill(tokens.accentSolid).frame(width: 16, height: 3)
                Text(view.legend.sent).font(.caption).foregroundStyle(.secondary)
            }
            if view.hasCounterfactual {
                HStack(spacing: Metrics.spacing.sp2) {
                    Capsule().stroke(tokens.tx3, style: StrokeStyle(lineWidth: 1.5, dash: [3, 2])).frame(width: 16, height: 3)
                    Text(view.legend.raw).font(.caption).foregroundStyle(.secondary)
                }
            } else if let note = view.legend.noCounterfactual {
                Text(note).font(.caption).foregroundStyle(.secondary)
            }
        }
    }

    // MARK: - Stats, metered, activity

    private func statsSection(_ summary: OptimizerSummaryViewWire) -> some View {
        var stats: [OptimizerStatWire] = []
        if case .loaded(_, let view) = store.series { stats += view.stats }
        stats += summary.stats
        return Section("Stats") {
            Grid(alignment: .leading, horizontalSpacing: Metrics.spacing.sp3, verticalSpacing: Metrics.spacing.sp3) {
                ForEach(Array(stride(from: 0, to: stats.count, by: 2)), id: \.self) { start in
                    GridRow {
                        statCell(stats[start])
                        if start + 1 < stats.count { statCell(stats[start + 1]) } else { Color.clear }
                    }
                }
            }
        }
    }

    private func statCell(_ stat: OptimizerStatWire) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(stat.label).font(.caption).foregroundStyle(.secondary)
            Text(stat.value).font(.body.weight(.semibold)).foregroundStyle(toneColor(stat.tone))
            Text(stat.detail).font(.caption2).foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityElement(children: .combine)
    }

    private func meteredSection(_ view: OptimizerSummaryViewWire) -> some View {
        Section {
            ForEach(Array(view.metered.enumerated()), id: \.offset) { _, row in
                HStack {
                    Text(row.name)
                    Spacer()
                    Text("\(row.role) · \(row.price)").font(.caption).foregroundStyle(.secondary)
                }
            }
        } header: {
            Text("Pay-per-token endpoints")
        } footer: {
            Text(view.meteredCaption)
        }
    }

    private func activitySection(_ view: OptimizerSummaryViewWire) -> some View {
        Section {
            if view.activity.isEmpty {
                Text(view.activityEmpty).foregroundStyle(.secondary)
            }
            ForEach(view.activity) { entry in
                HStack(alignment: .top, spacing: Metrics.spacing.sp2) {
                    Text(OptimizerChart.formatClock(entry.ts)).font(.caption.monospacedDigit()).foregroundStyle(.secondary)
                    VStack(alignment: .leading, spacing: 2) {
                        Text(entry.headline)
                            .strikethrough(entry.rolledBack)
                            .foregroundStyle(entry.rolledBack ? tokens.tx3 : tokens.tx1)
                        if !entry.detail.isEmpty {
                            Text(entry.detail).font(.caption).foregroundStyle(.secondary)
                        }
                    }
                }
                .accessibilityElement(children: .combine)
            }
        } header: {
            Text("Activity")
        } footer: {
            Text(view.activityCaption)
        }
    }

    // MARK: - Tints

    private func bandColor(_ band: String) -> Color {
        switch band {
        case "danger": return tokens.danger
        case "warn": return tokens.warn
        default: return tokens.ok
        }
    }

    private func toneColor(_ tone: String) -> Color {
        switch tone {
        case "ok": return tokens.ok
        case "warn": return tokens.warn
        case "danger": return tokens.danger
        default: return tokens.tx1
        }
    }
}

// MARK: - Gauge

/// A plan window's fill (colour = the box's `band`) with a thin tick at the
/// forecast-at-reset (warn-tinted when the box says it is ahead).
struct OptimizerGauge: View {
    let pct: Double
    let forecastPct: Double?
    let forecastWarn: Bool
    let fill: Color
    let tokens: Tokens

    var body: some View {
        GeometryReader { geo in
            ZStack(alignment: .leading) {
                Capsule().fill(tokens.borderSubtle)
                Capsule().fill(fill).frame(width: geo.size.width * CGFloat(UsageMeters.clamp(pct)) / 100)
                if let forecastPct {
                    Rectangle()
                        .fill(forecastWarn ? tokens.warn : tokens.tx2)
                        .frame(width: 2, height: 10)
                        .offset(x: geo.size.width * CGFloat(UsageMeters.clamp(forecastPct)) / 100 - 1)
                }
            }
        }
        .frame(height: 8)
        .accessibilityHidden(true)
    }
}

// MARK: - Chart

/// Cumulative "sent" (solid, filled) and, when the box says trims were actually
/// applied, the cumulative raw counterfactual (dashed). Geometry is `OptimizerChart`.
struct OptimizerChartView: View {
    let points: [OptimizerSeriesPointWire]
    /// Per-bucket raw values from the box (`view.rawValues`), or nil without a counterfactual.
    let rawValues: [Double]?
    let bucket: String
    let tokens: Tokens

    private struct Sample: Identifiable {
        let id: Int
        let date: Date
        let value: Double
    }

    private var sent: [Sample] {
        let cumulative = OptimizerChart.cumulative(points.map(\.tokensSent))
        return points.enumerated().map { Sample(id: $0.offset, date: Date(timeIntervalSince1970: $0.element.t / 1000), value: cumulative[$0.offset]) }
    }

    private var raw: [Sample] {
        guard let rawValues, rawValues.count == points.count else { return [] }
        let cumulative = OptimizerChart.cumulative(rawValues)
        return points.enumerated().map { Sample(id: $0.offset, date: Date(timeIntervalSince1970: $0.element.t / 1000), value: cumulative[$0.offset]) }
    }

    private var ticks: [(date: Date, label: String)] {
        OptimizerChart.axisTicks(points.map(\.t), bucket: bucket).map {
            (Date(timeIntervalSince1970: points[$0.index].t / 1000), $0.label)
        }
    }

    var body: some View {
        let sentSamples = sent
        let rawSamples = raw
        let tickList = ticks
        Chart {
            ForEach(sentSamples) { sample in
                AreaMark(x: .value("Time", sample.date), y: .value("Tokens", sample.value))
                    .foregroundStyle(tokens.accentSolid.opacity(0.15))
                LineMark(x: .value("Time", sample.date), y: .value("Tokens", sample.value), series: .value("Series", "sent"))
                    .foregroundStyle(tokens.accentSolid)
            }
            ForEach(rawSamples) { sample in
                LineMark(x: .value("Time", sample.date), y: .value("Tokens", sample.value), series: .value("Series", "raw"))
                    .foregroundStyle(tokens.tx3)
                    .lineStyle(StrokeStyle(lineWidth: 1.5, dash: [4, 3]))
            }
        }
        .chartXAxis {
            AxisMarks(values: tickList.map(\.date)) { value in
                AxisGridLine()
                AxisValueLabel {
                    if let date = value.as(Date.self), let tick = tickList.first(where: { $0.date == date }) {
                        Text(tick.label).font(.caption2)
                    }
                }
            }
        }
        .chartYAxis {
            AxisMarks(position: .leading) { value in
                AxisGridLine()
                AxisValueLabel {
                    if let number = value.as(Double.self) {
                        Text(UsageMeters.formatTokens(number)).font(.caption2)
                    }
                }
            }
        }
    }
}
