import { useCallback, useEffect, useState } from "react";
import {
  Activity,
  AlertTriangle,
  Boxes,
  CalendarRange,
  ChevronDown,
  ClipboardCheck,
  History,
  Home,
  KeyRound,
  LayoutGrid,
  Settings,
  ShieldCheck,
  GraduationCap,
  FileSpreadsheet,
  Shirt,
  UserPlus,
  Users,
  Ticket,
  Wallet,
  Wifi,
} from "lucide-react";
import {
  DistributedAppController,
  type ArgusAppProjection,
} from "./distributed/appIntegration";
import type { ArgusPermission, ArgusRole } from "./distributed/types";
import { ROLE_PERMISSIONS } from "./auth/authorization";
import { IndexedDbRepository, MemoryRepository } from "./storage/repository";
import { plural } from "./plural";
import {
  LocalSettingsStorage,
  type SettingsStorage,
  type UserSettings,
} from "./settings";
import { resolveBlockchainMode } from "./blockchain/config";
import { SupplyWorkflow } from "./components/SupplyWorkflow";
import "./app-shell.css";
import { Drawer, Summary } from "./components/Drawer";
import { SharedCountView } from "./features/count/SharedCountView";
import { InventoryCatalogView } from "./features/inventory/InventoryCatalogView";
import { COUNT_INTERVAL_CHOICES } from "./stage3/inventoryStatus";
import { CadetsView } from "./features/cadets/CadetsView";
import { ConflictsPanel } from "./features/conflicts/ConflictsPanel";
import { StillNeededActions } from "./features/needs/StillNeededActions";
import { Dashboard, type DashboardTarget } from "./features/dashboard";
import { ReadinessWeightsEditor } from "./features/dashboard/ReadinessWeightsEditor";
import { StandardIssueGaps } from "./features/readiness/StandardIssueGaps";
import type { SyncSnapshot } from "./stage3/readinessTypes";
import { CalendarView } from "./features/calendar";
import { BundleEditorPanel } from "./features/bundles";
import {
  ExportPanel,
  RolloverPanel,
  RosterImportPanel,
} from "./features/admin";
import { ActivityView } from "./features/activity";
import { cadetLabel } from "./stage3/domain";
import { UnitGate } from "./unit/screens/UnitGate";
import { TicketsPanel } from "./unit/screens/TicketsPanel";
import { MembersPanel, WalletPanel } from "./unit/screens/UnitPanels";
import { roleLabel, syncLabel, syncOutcome } from "./unit/screens/labels";
import {
  DeviceNotificationSettings,
  useDeviceNotifications,
} from "./notifications";
import type {
  UnitRuntime,
  UnitRuntimeOptions,
  UnitStatus,
} from "./unit/runtime";

export type Tab =
  "home" | "count" | "inventory" | "cadets" | "calendar" | "activity" | "more";
type Panel =
  | "cadet-issue"
  | "cadet-return"
  | "bundles"
  | "needed"
  | "members"
  | "tickets"
  | "wallet"
  | "conflicts"
  | "diagnostics"
  | "import"
  | "rollover"
  | "export"
  | null;
const nav: Array<{ id: Tab; label: string; icon: typeof Activity }> = [
  { id: "home", label: "Home", icon: Home },
  { id: "count", label: "Count", icon: ClipboardCheck },
  { id: "inventory", label: "Inventory", icon: Boxes },
  { id: "cadets", label: "Cadets", icon: Users },
  { id: "calendar", label: "Calendar", icon: CalendarRange },
  { id: "activity", label: "Activity", icon: History },
  { id: "more", label: "More", icon: LayoutGrid },
];
/** Phones get the five most-used sections; Calendar and Activity are one tap away from Home. */
const mobileNav = nav.filter((item) =>
  ["home", "count", "inventory", "cadets", "more"].includes(item.id),
);
const pageTitle = (tab: Tab) =>
  ({
    home: "Home",
    count: "Shared Count",
    inventory: "Inventory",
    cadets: "Cadets",
    calendar: "Supply Calendar",
    activity: "Activity",
    more: "Command Center",
  })[tab];

type Props = {
  /** Supplying a controller skips the unit gate (tests and mock-development demos). */
  controller?: DistributedAppController;
  settingsStorage?: SettingsStorage;
  runtimeOptions?: UnitRuntimeOptions;
  storage?: Pick<Storage, "getItem" | "setItem" | "removeItem">;
};

/**
 * The live app always goes through the unit gate: each person unlocks their own device key, and
 * the unit's shared data comes from BSV testnet. Only an explicit mock-development build (or a
 * test that passes a controller) runs the single-device demo.
 */
export default function App({
  controller,
  runtimeOptions,
  storage,
  ...rest
}: Props) {
  if (controller) return <AuthenticatedApp controller={controller} {...rest} />;
  if (
    resolveBlockchainMode(import.meta.env.VITE_ARGUS_BLOCKCHAIN_MODE) ===
    "mock-development"
  )
    return <DemoApp {...rest} />;
  return (
    <UnitGate runtimeOptions={runtimeOptions} {...(storage ? { storage } : {})}>
      {(runtime, lock) => (
        <AuthenticatedApp
          controller={runtime.controller}
          runtime={runtime}
          onLock={lock}
          {...rest}
        />
      )}
    </UnitGate>
  );
}

/** The mock-development demo keeps its (plaintext, demo-only) records in its own IndexedDB database so a reload keeps them. */
const DEMO_DATABASE_NAME = "argus-demo";
function DemoApp(props: Omit<Props, "controller">) {
  const [controller] = useState(
    () =>
      new DistributedAppController(
        globalThis.indexedDB
          ? new IndexedDbRepository(DEMO_DATABASE_NAME)
          : new MemoryRepository(),
      ),
  );
  return <AuthenticatedApp controller={controller} {...props} />;
}

type AuthenticatedAppProps = Omit<
  Props,
  "controller" | "runtimeOptions" | "storage"
> & {
  controller: DistributedAppController;
  runtime?: UnitRuntime;
  onLock?: () => void;
};

function AuthenticatedApp({
  controller,
  runtime,
  settingsStorage: suppliedSettings,
  onLock,
}: AuthenticatedAppProps) {
  const [settingsStorage] = useState(
    () => suppliedSettings ?? new LocalSettingsStorage(),
  );
  const [preferences, setPreferences] = useState<UserSettings>(() =>
    settingsStorage.load(),
  );
  const [projection, setProjection] = useState<ArgusAppProjection>();
  const [reportedStatus, setStatus] = useState<UnitStatus | undefined>(() =>
    runtime?.status(),
  );
  const [selectedTab, setTab] = useState<Tab>(preferences.defaultSection);
  const [panel, setPanel] = useState<Panel>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [notice, setNotice] = useState("");
  const [countItemId, setCountItemId] = useState<string>();
  const [workflowCadetId, setWorkflowCadetId] = useState<string>();
  // The exact record an alert or readiness link opened (event drawer, cadet,
  // filtered inventory); plain navigation clears it.
  const [focus, setFocus] = useState<{
    target: DashboardTarget;
    nonce: number;
  }>();

  useEffect(() => {
    let active = true,
      stopSync: undefined | (() => void);
    const stopProjection = runtime?.onProjection((next) => {
      if (active) setProjection(next);
    });
    const stopStatus = runtime?.onStatus((next) => {
      if (active) setStatus(next);
    });
    // A unit runtime was initialized by the gate; a bare controller (demo/tests) initializes here.
    (runtime ? controller.project() : controller.initialize())
      .then((p) => {
        if (!active) return;
        setProjection(p);
        stopSync = controller.startAutoSync((next) => {
          if (active) setProjection(next);
        });
      })
      .catch((e) =>
        setNotice(
          e instanceof Error ? e.message : "Local data could not be loaded.",
        ),
      );
    return () => {
      active = false;
      stopSync?.();
      stopProjection?.();
      stopStatus?.();
    };
  }, [controller, runtime]);
  useEffect(() => {
    settingsStorage.save(preferences);
    Object.assign(document.documentElement.dataset, {
      theme: preferences.theme,
      density: preferences.density,
      motion: preferences.motion,
      textSize: preferences.textSize,
    });
  }, [preferences, settingsStorage]);
  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(""), 6000);
    return () => clearTimeout(timer);
  }, [notice]);

  const role: ArgusRole | "PENDING" =
    runtime?.device.record.role ?? "SUPPLY_OFFICER";
  // Permissions come from the person's signed credential (spec §4: configurable, not scattered through the UI); a removed person has none.
  const revoked = Boolean(reportedStatus?.revoked);
  const credential = runtime?.device.record.credential;
  const can = useCallback(
    (permission: ArgusPermission) =>
      role !== "PENDING" &&
      !revoked &&
      (runtime
        ? (credential?.permissions ?? [])
        : ROLE_PERMISSIONS.SUPPLY_OFFICER
      ).includes(permission),
    [role, revoked, runtime, credential],
  );
  // The audit trail is for people with audit.read (not Supply Assistants): no tab, no route.
  const canViewActivity = can("audit.read");
  const tab: Tab =
    selectedTab === "activity" && !canViewActivity ? "home" : selectedTab;
  const sections = nav.filter(
    (item) => item.id !== "activity" || canViewActivity,
  );
  const memberName = useCallback(
    (publicIdentity: string) => {
      if (projection && publicIdentity === projection.actor) return "You";
      return (
        projection?.members.find(
          (member) => member.publicIdentity === publicIdentity,
        )?.displayName ?? "Unit member"
      );
    },
    [projection],
  );
  const notify = useCallback((message: string) => setNotice(message), []);
  // Sync now (Count): says what actually happened, never "synchronized" while the network is unreachable.
  const syncNow = useCallback(async () => {
    if (!runtime) {
      const next = await controller.sync();
      return {
        projection: next,
        message: "Up to date. This demo keeps its records on this device only.",
      };
    }
    const next = await runtime.syncNow();
    return { projection: next, message: syncOutcome(runtime.status()).message };
  }, [controller, runtime]);
  // The local copy knows every change still waiting to publish even while the last network check failed.
  const waiting = Math.max(
    reportedStatus?.queued ?? 0,
    projection?.sync.outbox ?? 0,
  );
  const status: UnitStatus | undefined = reportedStatus && {
    ...reportedStatus,
    queued: waiting,
  };
  // Tier 2 device notifications (spec §20); a notification click routes like a dashboard alert click.
  useDeviceNotifications({
    enabled: preferences.deviceNotifications,
    projection,
    sync: {
      needsFunding: Boolean(status?.needsFunding),
      state: status?.state,
      queued: waiting,
    },
    onOpen: ({ tab: next, panel: nextPanel }) => {
      setSettingsOpen(false);
      setTab(next);
      setPanel(nextPanel ?? null);
    },
  });
  const mode = runtime ? "testnet" : "mock";

  if (!projection)
    return (
      <main className="loading-state" aria-live="polite">
        <strong>Loading A.R.G.U.S.…</strong>
        {notice && <p role="alert">{notice}</p>}
      </main>
    );
  const syncText = projection.sync.openConflicts
    ? "CONFLICT · ACTION REQUIRED"
    : status
      ? syncLabel(status)
      : "MOCK · THIS DEVICE ONLY";
  const who = runtime?.device.record.displayName ?? "Demo user";
  const initialsOf = who
    .split(/\s+/)
    .map((part) => part[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();
  const openCadetWorkflow = (
    kind: "cadet-issue" | "cadet-return",
    cadetId: string,
  ) => {
    setWorkflowCadetId(cadetId);
    setPanel(kind);
  };
  const openTarget = (target: DashboardTarget) => {
    setTab(target.tab);
    setPanel(target.panel ?? null);
    const exact = Boolean(
      target.calendarEventId ||
      target.cadetId ||
      target.itemId ||
      target.filter,
    );
    setFocus((previous) =>
      exact ? { target, nonce: (previous?.nonce ?? 0) + 1 } : undefined,
    );
  };
  const showTab = (next: Tab) => {
    setTab(next);
    setFocus(undefined);
  };
  const focused = (which: Tab) =>
    focus?.target.tab === which ? focus : undefined;
  const syncSnapshot: SyncSnapshot = {
    needsFunding: Boolean(status?.needsFunding),
    state: status?.state,
    queued: waiting,
    unreadable: status?.unreadable,
    lastScanAt: status?.lastScanAt,
    revoked: status?.revoked,
  };
  // Master spec §5: the dashboard is itself the navigation surface, so the normal taskbar is hidden there.
  const onDashboard = tab === "home";
  return (
    <div className={onDashboard ? "app-shell dashboard-mode" : "app-shell"}>
      <div className="aether-field" aria-hidden="true">
        <span />
        <span />
        <span />
      </div>
      {!onDashboard && (
        <aside className="sidebar">
          <Brand />
          <nav aria-label="Primary navigation">
            {sections.map(({ id, label, icon: Icon }) => (
              <button
                key={id}
                className={tab === id ? "nav-item active" : "nav-item"}
                onClick={() => showTab(id)}
              >
                <Icon size={19} />
                <span>{label}</span>
              </button>
            ))}
          </nav>
          <div className="system-card">
            <span className="pulse" />
            <strong>
              {runtime ? runtime.device.record.unit?.unitName : "Demo unit"}
            </strong>
            <p>{syncText}</p>
          </div>
          <button className="profile" onClick={() => setSettingsOpen(true)}>
            <span className="avatar">{initialsOf}</span>
            <span>
              <strong>{who}</strong>
              <small>{roleLabel(role)}</small>
            </span>
            <ChevronDown size={16} />
          </button>
        </aside>
      )}
      <main className="main-stage">
        <div className={`environment-banner ${mode}`} role="note">
          <strong>
            {mode === "testnet" ? "BSV TESTNET" : "MOCK BLOCKCHAIN"}
          </strong>
          <span>Development Environment · No Production Transactions</span>
        </div>
        {revoked && (
          <div className="workflow-error" role="alert">
            A Master removed your access to {status?.unitName}. This device
            still shows what it already had, but nothing new you record will be
            accepted, and it cannot read anything written after your removal.
          </div>
        )}
        <header className="topbar">
          <div>
            <p className="eyebrow">
              {(
                runtime?.device.record.unit?.unitName ?? "A.R.G.U.S. demo"
              ).toUpperCase()}
            </p>
            <h1>{pageTitle(tab)}</h1>
          </div>
          <div className="top-actions">
            <button
              className="sync"
              title={syncText}
              onClick={() =>
                setPanel(
                  projection.sync.openConflicts
                    ? "conflicts"
                    : runtime
                      ? "wallet"
                      : null,
                )
              }
            >
              <Wifi size={15} />
              <span className="sync-text">{syncText}</span>
            </button>
            <button
              aria-label="Settings"
              className="icon-button"
              onClick={() => setSettingsOpen(true)}
            >
              <Settings size={20} />
            </button>
            <button
              className="top-identity"
              onClick={() => setSettingsOpen(true)}
              aria-label={`Signed in as ${who}, ${roleLabel(role)}`}
              title={`${who} · ${roleLabel(role)}`}
            >
              <b aria-hidden="true">{initialsOf}</b>
              <span>
                <span>{who}</span>
                <small>{roleLabel(role)}</small>
              </span>
            </button>
          </div>
        </header>
        {tab === "home" && (
          <Dashboard
            projection={projection}
            sync={{ label: syncText, ...syncSnapshot }}
            weights={preferences.readinessWeights}
            unitName={
              runtime?.device.record.unit?.unitName ?? "A.R.G.U.S. demo"
            }
            canViewActivity={canViewActivity}
            navigate={openTarget}
            onQuickAction={(action) => {
              if (action === "count") setTab("count");
              else {
                setWorkflowCadetId(undefined);
                setPanel(action === "issue" ? "cadet-issue" : "cadet-return");
              }
            }}
          />
        )}
        {tab === "calendar" && (
          <CalendarView
            key={`calendar-${focused("calendar")?.nonce ?? 0}`}
            initialEventId={focused("calendar")?.target.calendarEventId}
            sync={syncSnapshot}
            navigate={openTarget}
            projection={projection}
            controller={controller}
            can={can}
            memberName={memberName}
            onProjection={setProjection}
            notify={notify}
          />
        )}
        {tab === "count" && (
          <SharedCountView
            key={countItemId ?? "count"}
            projection={projection}
            controller={controller}
            can={can}
            memberName={memberName}
            onProjection={setProjection}
            notify={notify}
            syncNow={syncNow}
            {...(countItemId ? { initialItemId: countItemId } : {})}
          />
        )}
        {tab === "inventory" && (
          <InventoryCatalogView
            key={`inventory-${focused("inventory")?.nonce ?? 0}`}
            initialAttentionOnly={
              focused("inventory")?.target.filter === "attention"
            }
            initialItemId={focused("inventory")?.target.itemId}
            projection={projection}
            controller={controller}
            can={can}
            onProjection={setProjection}
            notify={notify}
            onCount={(itemId) => {
              setCountItemId(itemId);
              setTab("count");
            }}
            onOpenConflicts={() => setPanel("conflicts")}
            countIntervalDays={preferences.countIntervalDays}
          />
        )}
        {tab === "cadets" && (
          <CadetsView
            key={`cadets-${focused("cadets")?.nonce ?? 0}`}
            initialCadetId={focused("cadets")?.target.cadetId}
            initialFilter={
              focused("cadets")?.target.filter === "inactive"
                ? "INACTIVE"
                : undefined
            }
            projection={projection}
            controller={controller}
            can={can}
            onProjection={setProjection}
            notify={notify}
            onIssue={(cadetId) => openCadetWorkflow("cadet-issue", cadetId)}
            onReturn={(cadetId) => openCadetWorkflow("cadet-return", cadetId)}
          />
        )}
        {tab === "activity" && (
          <ActivityView
            projection={projection}
            memberName={memberName}
            runtime={runtime}
            status={status}
          />
        )}
        {tab === "more" && (
          <CommandCenter
            projection={projection}
            hasRuntime={Boolean(runtime)}
            canMakeTickets={Boolean(
              runtime &&
              !revoked &&
              (role === "MASTER" || role === "INSTRUCTOR"),
            )}
            can={can}
            open={setPanel}
            settings={() => setSettingsOpen(true)}
            lock={onLock}
          />
        )}
      </main>
      {notice && (
        // Outside <main> and exempt from the drawers' inert background, so results of a drawer action are still announced.
        <div className="app-notice" role="status" data-modal-keep>
          {notice}
        </div>
      )}
      {!onDashboard && (
        <nav className="mobile-nav" aria-label="Mobile navigation">
          {mobileNav.map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              className={tab === id ? "active" : ""}
              onClick={() => showTab(id)}
            >
              <Icon size={21} />
              <span>{label}</span>
            </button>
          ))}
        </nav>
      )}
      {(panel === "cadet-issue" || panel === "cadet-return") && (
        <SupplyWorkflow
          mode={panel === "cadet-issue" ? "ISSUE" : "RETURN"}
          projection={projection}
          controller={controller}
          selectedCadetId={workflowCadetId}
          onClose={() => setPanel(null)}
          onChanged={setProjection}
        />
      )}
      {panel === "bundles" && (
        <BundleEditorPanel
          projection={projection}
          controller={controller}
          can={can}
          memberName={memberName}
          onProjection={setProjection}
          notify={notify}
          close={() => setPanel(null)}
        />
      )}
      {panel === "import" && (
        <RosterImportPanel
          projection={projection}
          controller={controller}
          can={can}
          onProjection={setProjection}
          notify={notify}
          close={() => setPanel(null)}
        />
      )}
      {panel === "rollover" && (
        <RolloverPanel
          projection={projection}
          controller={controller}
          can={can}
          onProjection={setProjection}
          notify={notify}
          close={() => setPanel(null)}
        />
      )}
      {panel === "export" && (
        <ExportPanel
          projection={projection}
          notify={notify}
          close={() => setPanel(null)}
        />
      )}
      {panel === "needed" && (
        <NeededPanel
          projection={projection}
          close={() => setPanel(null)}
          controller={controller}
          canManage={can("cadets.manage")}
          onProjection={setProjection}
          notify={notify}
          openCadet={(cadetId) => openTarget({ tab: "cadets", cadetId })}
        />
      )}
      {panel === "conflicts" && (
        <ConflictsPanel
          projection={projection}
          controller={controller}
          can={can}
          memberName={memberName}
          close={() => setPanel(null)}
          onProjection={setProjection}
          notify={notify}
        />
      )}
      {panel === "members" && runtime && (
        <MembersPanel
          runtime={runtime}
          projection={projection}
          close={() => setPanel(null)}
          onProjection={setProjection}
          notify={notify}
        />
      )}
      {panel === "tickets" && runtime && (
        <TicketsPanel
          runtime={runtime}
          projection={projection}
          close={() => setPanel(null)}
          notify={notify}
        />
      )}
      {panel === "wallet" && runtime && status && (
        <WalletPanel
          runtime={runtime}
          status={status}
          close={() => setPanel(null)}
          notify={notify}
        />
      )}
      {panel === "diagnostics" && (
        <DiagnosticsPanel
          projection={projection}
          close={() => setPanel(null)}
        />
      )}
      {settingsOpen && (
        <SettingsPanel
          sections={sections}
          value={preferences}
          change={setPreferences}
          close={() => setSettingsOpen(false)}
        />
      )}
    </div>
  );
}

function Brand() {
  return (
    <div className="brand">
      <img src={`${import.meta.env.BASE_URL}argus-mark.svg`} alt="" />
      <div>
        <strong>A.R.G.U.S.</strong>
        <span>ASSET READINESS SYSTEM</span>
      </div>
    </div>
  );
}

type CommandAction = [Exclude<Panel, null>, string, string, typeof Activity];
function CommandCenter({
  projection,
  hasRuntime,
  canMakeTickets,
  can,
  open,
  settings,
  lock,
}: {
  projection: ArgusAppProjection;
  hasRuntime: boolean;
  canMakeTickets: boolean;
  can: (permission: ArgusPermission) => boolean;
  open: (p: Panel) => void;
  settings: () => void;
  lock?: () => void;
}) {
  const unitActions: CommandAction[] = hasRuntime
    ? [
        [
          "members",
          "Members & access",
          "See who is in the unit, change roles, remove people",
          KeyRound,
        ],
        ...(canMakeTickets
          ? ([
              [
                "tickets",
                "Tickets",
                "Make a ticket for a new person, see tickets out, cancel one",
                Ticket,
              ],
            ] as CommandAction[])
          : []),
        [
          "wallet",
          "Wallet & sync",
          "This device's testnet coins and chain sync status",
          Wallet,
        ],
      ]
    : [];
  const actions: CommandAction[] = [
    ...unitActions,
    [
      "conflicts",
      `Conflicts${projection.sync.openConflicts ? ` · ${projection.sync.openConflicts} open` : ""}`,
      "Competing offline changes that need a decision",
      AlertTriangle,
    ],
    [
      "bundles",
      "Issue bundles",
      can("bundles.manage")
        ? "Edit bundle contents; every change is a new version"
        : "Bundle contents and version history",
      Shirt,
    ],
    ...(can("cadets.manage")
      ? ([
          [
            "import",
            "Import cadets",
            "Add a class of cadets by cadet ID (e.g. for NCO)",
            UserPlus,
          ],
          [
            "rollover",
            "Annual rollover",
            "Advance NS levels and graduate NS4 cadets",
            GraduationCap,
          ],
        ] as CommandAction[])
      : []),
    [
      "export",
      "Export unit spreadsheet",
      "Download cadets, current property, inventory, and outstanding needs",
      FileSpreadsheet,
    ],
    [
      "needed",
      "Still needed",
      "Unfulfilled cadet requirements",
      ClipboardCheck,
    ],
    [
      "diagnostics",
      "Diagnostics",
      "Data integrity and records that could not be applied",
      ShieldCheck,
    ],
  ];
  return (
    <div className="content">
      <section className="page-intro">
        <div>
          <p className="eyebrow">OPERATIONS</p>
          <h2>Command Center</h2>
          <p>Administration, readiness, and system controls in one place.</p>
        </div>
      </section>
      <div className="command-grid">
        {actions.map(([id, title, detail, Icon]) => (
          <button key={id} onClick={() => open(id)}>
            <span>
              <Icon />
            </span>
            <div>
              <strong>{title}</strong>
              <p>{detail}</p>
            </div>
          </button>
        ))}
        <button onClick={settings}>
          <span>
            <Settings />
          </span>
          <div>
            <strong>Settings</strong>
            <p>Appearance and behavior on this device</p>
          </div>
        </button>
        {lock && (
          <button onClick={lock}>
            <span>
              <KeyRound />
            </span>
            <div>
              <strong>Lock this device</strong>
              <p>Clear decrypted data from memory and require the passphrase</p>
            </div>
          </button>
        )}
      </div>
      <p className="safe-note">
        <ShieldCheck size={14} />{" "}
        {hasRuntime
          ? "Limitation: “verified” means the BSV testnet service reports the change in a mined block; this app does not yet check the block’s proof itself."
          : "Demo: records stay on this device and are never written to a blockchain."}
      </p>
    </div>
  );
}

function NeededPanel({
  projection,
  close,
  controller,
  canManage,
  onProjection,
  notify,
  openCadet,
}: {
  projection: ArgusAppProjection;
  close: () => void;
  controller: DistributedAppController;
  canManage: boolean;
  onProjection: (projection: ArgusAppProjection) => void;
  notify: (message: string) => void;
  openCadet: (cadetId: string) => void;
}) {
  const requirements = projection.stillNeeded,
    remaining = requirements.reduce(
      (sum, item) =>
        sum + Math.max(0, item.quantityNeeded - item.quantityFulfilled),
      0,
    ),
    ready = requirements.filter((item) => item.availability.available).length;
  return (
    <Drawer title="Still Needed" icon={<ClipboardCheck />} close={close}>
      <section className="needed-overview" aria-label="Requirement overview">
        <div>
          <small>OPEN REQUIREMENTS</small>
          <strong>{requirements.length}</strong>
          <span>
            Across{" "}
            {plural(
              new Set(requirements.map((item) => item.cadetId)).size,
              "cadet",
            )}
          </span>
        </div>
        <div>
          <small>UNITS REMAINING</small>
          <strong>{remaining}</strong>
          <span>{ready} ready to issue</span>
        </div>
      </section>
      <div className="needed-list">
        {requirements.length ? (
          requirements.map((n) => {
            const count = Math.max(0, n.quantityNeeded - n.quantityFulfilled);
            const catalogId =
              n.catalogId ??
              projection.inventory.find((item) => item.entityId === n.itemId)
                ?.catalogId ??
              projection.catalog.find((item) => item.name === n.displayLabel)
                ?.catalogId;
            const availableSizes = catalogId
              ? projection.inventory
                  .filter((item) => item.catalogId === catalogId && item.active)
                  .map((item) => item.variant)
              : [];
            const cadet = projection.cadets.find(
              (c) => c.cadetId === n.cadetId,
            );
            const code = cadet ? cadetLabel(cadet) : "Missing cadet";
            return (
              <article className="needed-card" key={n.requirementId}>
                <div className="needed-card-main">
                  <span className="needed-initials" aria-hidden="true">
                    {code.slice(2, 4)}
                  </span>
                  <div>
                    <strong>{code}</strong>
                    <p>
                      {n.displayLabel}
                      <span>·</span>
                      {n.size ?? "No size"}
                    </p>
                  </div>
                  <b
                    className="needed-quantity"
                    aria-label={`${count} remaining`}
                  >
                    {count}
                    <small>REMAINING</small>
                  </b>
                </div>
                <div className="needed-card-meta">
                  <span>
                    <CalendarRange />
                    First needed{" "}
                    <time dateTime={n.firstNeededAt}>
                      {new Date(n.firstNeededAt).toLocaleDateString()}
                    </time>
                  </span>
                  <em
                    className={
                      n.availability.available
                        ? "needed-status ready"
                        : "needed-status attention"
                    }
                  >
                    <span />
                    {!n.availability.configured
                      ? availableSizes.length
                        ? `Sizes: ${availableSizes.join(", ")}`
                        : "Not configured"
                      : n.availability.available
                        ? `${n.availability.onHand} available`
                        : "Awaiting stock"}
                  </em>
                </div>
                {canManage && (
                  <div className="needed-card-actions">
                    <StillNeededActions
                      need={n}
                      owner={code}
                      controller={controller}
                      onProjection={onProjection}
                      notify={notify}
                    />
                  </div>
                )}
              </article>
            );
          })
        ) : (
          <p className="empty-state">
            <strong>All requirements fulfilled</strong>
            <span>No equipment is currently waiting to be issued.</span>
          </p>
        )}
      </div>
      <StandardIssueGaps projection={projection} openCadet={openCadet} />
    </Drawer>
  );
}

function DiagnosticsPanel({
  projection,
  close,
}: {
  projection: ArgusAppProjection;
  close: () => void;
}) {
  const report = projection.integrity;
  return (
    <Drawer title="Diagnostics" icon={<ShieldCheck />} close={close}>
      <div className={report.healthy ? "validation" : "notice"}>
        <ShieldCheck />
        <div>
          <strong>
            {report.healthy ? "Data integrity healthy" : "Attention required"}
          </strong>
          <p>
            {report.issues.length
              ? `${plural(report.issues.length, "problem")} found in the records on this device. Nothing was changed or deleted.`
              : "No problems found in the records on this device."}
          </p>
        </div>
      </div>
      <div className="panel-rows">
        <Summary
          label="Events"
          value={String(projection.events.length)}
          detail="Signed changes known to this device"
        />
        <Summary
          label="Not applied"
          value={String(projection.rejected.length)}
          detail="Kept, re-checked whenever new history arrives"
          accent={projection.rejected.length > 0}
        />
      </div>
      {projection.rejected.length > 0 && (
        <div className="panel-rows" aria-label="Records not applied">
          {projection.rejected.map((r) => (
            <p key={r.eventId}>
              <b>{r.eventType.replaceAll("_", " ").toLowerCase()}</b> ·{" "}
              {r.reason}
            </p>
          ))}
        </div>
      )}
      <p>A.R.G.U.S. version {__APP_VERSION__}</p>
    </Drawer>
  );
}

function SettingsPanel({
  sections,
  value,
  change,
  close,
}: {
  sections: typeof nav;
  value: UserSettings;
  change: (v: UserSettings) => void;
  close: () => void;
}) {
  const set = <K extends keyof UserSettings>(k: K, v: UserSettings[K]) =>
    change({ ...value, [k]: v });
  return (
    <Drawer title="Settings" icon={<Settings />} close={close}>
      <h3>Appearance</h3>
      <label className="field">
        THEME
        <select
          aria-label="Appearance"
          value={value.theme}
          onChange={(e) =>
            set("theme", e.target.value as UserSettings["theme"])
          }
        >
          <option value="system">System</option>
          <option value="dark">Dark</option>
          <option value="light">Light</option>
        </select>
      </label>
      <label className="field">
        DENSITY
        <select
          aria-label="Density"
          value={value.density}
          onChange={(e) =>
            set("density", e.target.value as UserSettings["density"])
          }
        >
          <option value="comfortable">Comfortable</option>
          <option value="compact">Compact</option>
        </select>
      </label>
      <label className="field">
        MOTION
        <select
          aria-label="Motion"
          value={value.motion}
          onChange={(e) =>
            set("motion", e.target.value as UserSettings["motion"])
          }
        >
          <option value="full">Full</option>
          <option value="reduced">Reduced</option>
        </select>
      </label>
      <label className="field">
        TEXT SIZE
        <select
          aria-label="Text size"
          value={value.textSize}
          onChange={(e) =>
            set("textSize", e.target.value as UserSettings["textSize"])
          }
        >
          <option value="standard">Standard</option>
          <option value="large">Large</option>
        </select>
      </label>
      <label className="field">
        DEFAULT SECTION
        <select
          aria-label="Default section"
          value={value.defaultSection}
          onChange={(e) => set("defaultSection", e.target.value as Tab)}
        >
          {sections.map((n) => (
            <option key={n.id} value={n.id}>
              {pageTitle(n.id)}
            </option>
          ))}
        </select>
      </label>
      <h3>Notifications</h3>
      <DeviceNotificationSettings
        enabled={value.deviceNotifications}
        onChange={(on) => set("deviceNotifications", on)}
      />
      <ReadinessWeightsEditor
        value={value.readinessWeights}
        change={(weights) => set("readinessWeights", weights)}
      />
      <h3>Inventory</h3>
      <label className="field">
        COUNT DUE AFTER
        <select
          aria-label="Count due after"
          value={value.countIntervalDays}
          onChange={(e) => set("countIntervalDays", Number(e.target.value))}
        >
          {COUNT_INTERVAL_CHOICES.map((days) => (
            <option key={days} value={days}>
              {days} days without a count
            </option>
          ))}
        </select>
      </label>
      <p>A.R.G.U.S. version {__APP_VERSION__}</p>
    </Drawer>
  );
}
