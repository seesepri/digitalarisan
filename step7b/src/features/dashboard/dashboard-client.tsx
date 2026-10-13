"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { FormEvent, useEffect, useMemo, useRef, useState } from "react";
import { Icon, type IconName } from "@/components/icon";
import { ApiClientError, apiFetch, newIdempotencyKey } from "@/lib/api-client";
import { daysRemaining, formatDate, formatDateTime, formatIDR, initials } from "@/lib/format";

type User = { id: string; name: string; email: string | null; phone: string; role: "USER" | "ADMIN" | "SUPER_ADMIN" };
type Wallet = { availableBalance: number; lockedBalance: number; pendingBalance: number; totalBalance: number };
type Membership = {
  participantId: string;
  periodId: string;
  periodCode: string;
  name: string;
  contributionAmount: number;
  participantStatus: "ACTIVE" | "CANCELLED" | "WINNER" | "COMPLETED";
  periodStatus: string;
  drawingAt: string;
  cancellationDeadlineAt: string;
  maximumParticipants: number;
  participantCount: number;
};
type Transaction = {
  id: string;
  type: string;
  direction: string;
  amount: number;
  description: string;
  status: string;
  createdAt: string;
};
type DashboardData = { user: User; wallet: Wallet; memberships: Membership[]; recentTransactions: Transaction[]; unreadNotifications: number };
type Period = {
  id: string;
  code: string;
  typeId: string;
  name: string;
  description: string;
  contributionAmount: number;
  minimumParticipants: number;
  maximumParticipants: number;
  registrationStartsAt: string;
  registrationEndsAt: string;
  drawingAt: string;
  cancellationDeadlineAt: string;
  status: string;
  participantCount: number;
};
type AppNotification = { id: string; title: string; message: string; type: string; readAt: string | null; createdAt: string };
type TopupPayment = { id: string; amount: number; status: string; checkoutUrl: string | null; expiresAt: string };
type AdminMetrics = {
  users: { totalUsers: number; activeUsers: number; suspendedUsers: number };
  wallets: { totalWalletBalance: string; totalAvailableBalance: string; totalLockedBalance: string; totalPendingBalance: string };
  arisan: { activeArisan: number; completedArisan: number; activeParticipants: number; allParticipants: number };
  finance: { totalTopups: string; totalWithdrawals: string; totalPayout: string };
};
type TypeOption = { id: string; name: string; contributionAmount: number; minimumParticipants: number; maximumParticipants: number; cancellationDeadlineDays: number; platformFeeBps: number; active: boolean };
type AdminPeriod = { id: string; code: string; name: string; contributionAmount: number; minimumParticipants: number; maximumParticipants: number; registrationStartsAt: string; registrationEndsAt: string; drawingAt: string; cancellationDeadlineAt: string; status: string; participantCount: number };
type Tab = "home" | "explore" | "mine" | "wallet" | "notifications" | "profile" | "settings" | "help" | "admin";
type Dialog = { kind: "join"; period: Period } | { kind: "cancel"; membership: Membership } | { kind: "topup" } | { kind: "withdraw" } | { kind: "create-type" } | { kind: "create-period" } | null;

function loadSavedTopup(): TopupPayment | null {
  if (typeof window === "undefined") return null;
  try {
    const value = JSON.parse(window.localStorage.getItem("seearisan:pending-topup") ?? "null") as Partial<TopupPayment> | null;
    if (!value || typeof value.id !== "string" || typeof value.amount !== "number" || typeof value.status !== "string" || typeof value.expiresAt !== "string") return null;
    const checkoutUrl = typeof value.checkoutUrl === "string" && value.checkoutUrl.startsWith("https://") ? value.checkoutUrl : null;
    return { id: value.id, amount: value.amount, status: value.status, checkoutUrl, expiresAt: value.expiresAt };
  } catch { return null; }
}

const navigation: Array<{ key: Tab; label: string; icon: IconName }> = [
  { key: "home", label: "Beranda", icon: "grid" },
  { key: "explore", label: "Jelajahi arisan", icon: "users" },
  { key: "wallet", label: "Wallet", icon: "wallet" },
];

export function DashboardClient() {
  const router = useRouter();
  const [tab, setTab] = useState<Tab>("home");
  const [data, setData] = useState<DashboardData | null>(null);
  const [periods, setPeriods] = useState<Period[]>([]);
  const [transactions, setTransactions] = useState<Transaction[]>([]);
  const [notifications, setNotifications] = useState<AppNotification[]>([]);
  const [adminMetrics, setAdminMetrics] = useState<AdminMetrics | null>(null);
  const [adminTypes, setAdminTypes] = useState<TypeOption[]>([]);
  const [adminPeriods, setAdminPeriods] = useState<AdminPeriod[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [toast, setToast] = useState<{ text: string; kind: "success" | "error" } | null>(null);
  const [dialog, setDialog] = useState<Dialog>(null);
  const [topupPayment, setTopupPayment] = useState<TopupPayment | null>(loadSavedTopup);
  const [pendingJoinPeriod, setPendingJoinPeriod] = useState<Period | null>(null);
  const [joinError, setJoinError] = useState("");
  const [profileMenuOpen, setProfileMenuOpen] = useState(false);
  const profileTriggerRef = useRef<HTMLButtonElement>(null);
  const [search, setSearch] = useState("");
  const [refreshKey, setRefreshKey] = useState(0);
  const user = data?.user ?? null;
  const wallet = data?.wallet ?? { availableBalance: 0, lockedBalance: 0, pendingBalance: 0, totalBalance: 0 };

  useEffect(() => {
    let mounted = true;
    async function load() {
      setLoading(true);
      const [dashboardResult, periodsResult] = await Promise.allSettled([
        apiFetch<DashboardData>("/api/v1/dashboard"),
        apiFetch<{ periods: Period[] }>("/api/v1/arisan/periods"),
      ]);
      if (!mounted) return;
      if (dashboardResult.status === "fulfilled") {
        setData(dashboardResult.value.data);
        setError("");
      } else {
        setData(null);
        if (dashboardResult.reason instanceof ApiClientError && dashboardResult.reason.status !== 401) setError(dashboardResult.reason.message);
      }
      if (periodsResult.status === "fulfilled") setPeriods(periodsResult.value.data.periods);
      else if (dashboardResult.status === "rejected" && dashboardResult.reason instanceof ApiClientError && dashboardResult.reason.status === 401) {
        setError(periodsResult.reason instanceof Error ? periodsResult.reason.message : "Katalog belum dapat dimuat.");
      }
      setLoading(false);
    }
    void load();
    return () => { mounted = false; };
  }, [refreshKey]);

  useEffect(() => {
    if (!user) return;
    const currentUser = user;
    let mounted = true;
    async function loadTabData() {
      if (tab === "wallet") {
        try {
          const result = await apiFetch<{ transactions: Transaction[] }>("/api/v1/wallet/transactions?limit=30");
          if (mounted) setTransactions(result.data.transactions);
        } catch (caught) { if (mounted) showToast(errorText(caught), "error"); }
      }
      if (tab === "notifications") {
        try {
          const result = await apiFetch<{ notifications: AppNotification[] }>("/api/v1/notifications");
          if (mounted) setNotifications(result.data.notifications);
        } catch (caught) { if (mounted) showToast(errorText(caught), "error"); }
      }
      if (tab === "admin" && currentUser.role !== "USER") {
        const [metrics, types, adminPeriodsResult] = await Promise.allSettled([
          apiFetch<AdminMetrics>("/api/v1/admin/dashboard"),
          apiFetch<{ types: TypeOption[] }>("/api/v1/admin/arisan/types"),
          apiFetch<{ periods: AdminPeriod[] }>("/api/v1/admin/arisan/periods"),
        ]);
        if (!mounted) return;
        if (metrics.status === "fulfilled") setAdminMetrics(metrics.value.data);
        if (types.status === "fulfilled") setAdminTypes(types.value.data.types);
        if (adminPeriodsResult.status === "fulfilled") setAdminPeriods(adminPeriodsResult.value.data.periods);
      }
    }
    void loadTabData();
    return () => { mounted = false; };
  }, [tab, user, refreshKey]);

  useEffect(() => {
    if (!toast) return;
    const timeout = window.setTimeout(() => setToast(null), 4200);
    return () => window.clearTimeout(timeout);
  }, [toast]);

  useEffect(() => {
    if (!topupPayment || ["SUCCESS", "FAILED", "EXPIRED"].includes(topupPayment.status)) {
      window.localStorage.removeItem("seearisan:pending-topup");
      return;
    }
    window.localStorage.setItem("seearisan:pending-topup", JSON.stringify(topupPayment));
  }, [topupPayment]);

  const activeMemberships = useMemo(() => (data?.memberships ?? []).filter((item) => item.participantStatus === "ACTIVE"), [data]);
  const filteredPeriods = useMemo(() => {
    const value = search.trim().toLowerCase();
    if (!value) return periods;
    return periods.filter((item) => `${item.name} ${item.code}`.toLowerCase().includes(value));
  }, [periods, search]);

  function refresh() { setRefreshKey((current) => current + 1); }
  function openJoin(period: Period) { setJoinError(""); setDialog({ kind: "join", period }); }
  function openTopup() {
    if (!topupPayment || ["SUCCESS", "FAILED", "EXPIRED"].includes(topupPayment.status)) setTopupPayment(null);
    setDialog({ kind: "topup" });
  }
  function showToast(text: string, kind: "success" | "error" = "success") { setToast({ text, kind }); }
  function errorText(caught: unknown) { return caught instanceof ApiClientError ? caught.message : "Terjadi kendala. Silakan coba lagi."; }

  async function confirmJoin(period: Period) {
    if (!user) { router.push("/login"); return; }
    setBusy(true);
    try {
      const result = await apiFetch<{ participantId: string }>(`/api/v1/arisan/periods/${period.id}/join`, {
        method: "POST",
        headers: { "idempotency-key": newIdempotencyKey("JOIN") },
        body: JSON.stringify({}),
      });
      setDialog(null);
      setPendingJoinPeriod(null);
      showToast(result.message || "Iuran berhasil dikunci.");
      refresh();
    } catch (caught) {
      if (caught instanceof ApiClientError && caught.code === "INSUFFICIENT_BALANCE") {
        setJoinError(caught.message);
        return;
      }
      setJoinError(errorText(caught));
    } finally { setBusy(false); }
  }

  async function confirmCancel(membership: Membership) {
    setBusy(true);
    try {
      await apiFetch(`/api/v1/arisan/participants/${membership.participantId}/cancel`, {
        method: "POST",
        headers: { "idempotency-key": newIdempotencyKey("CANCEL") },
        body: JSON.stringify({}),
      });
      setDialog(null);
      showToast("Kepesertaan dibatalkan. Dana sudah kembali ke saldo tersedia.");
      refresh();
    } catch (caught) {
      setDialog(null);
      showToast(errorText(caught), "error");
    } finally { setBusy(false); }
  }

  async function submitTopup(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const amount = Number(form.get("amount"));
    setBusy(true);
    try {
      const result = await apiFetch<{ topup: TopupPayment; payment: { configured: boolean; checkoutUrl: string | null } }>("/api/v1/wallet/topups", {
        method: "POST",
        headers: { "idempotency-key": newIdempotencyKey("TOPUP") },
        body: JSON.stringify({ amount }),
      });
      setTopupPayment(result.data.topup);
      showToast(result.data.payment.configured ? "Instruksi pembayaran siap. Saldo masuk setelah pembayaran diverifikasi." : "Instruksi pembayaran belum tersedia; saldo belum dikredit.", result.data.payment.configured ? "success" : "error");
      refresh();
    } catch (caught) { showToast(errorText(caught), "error"); }
    finally { setBusy(false); }
  }

  async function reconcileTopup() {
    if (!topupPayment) return;
    setBusy(true);
    try {
      const result = await apiFetch<{ topup: TopupPayment }>(`/api/v1/wallet/topups/${topupPayment.id}/reconcile`, { method: "POST", body: JSON.stringify({}) });
      setTopupPayment((current) => current ? { ...current, ...result.data.topup } : null);
      showToast(result.data.topup.status === "SUCCESS" ? "Pembayaran terverifikasi dan saldo diperbarui." : `Status pembayaran: ${result.data.topup.status}.`);
      refresh();
    } catch (caught) { showToast(errorText(caught), "error"); }
    finally { setBusy(false); }
  }

  async function submitWithdrawal(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const body = {
      amount: Number(form.get("amount")),
      bankName: String(form.get("bankName") ?? ""),
      accountName: String(form.get("accountName") ?? ""),
      accountNumber: String(form.get("accountNumber") ?? ""),
    };
    setBusy(true);
    try {
      await apiFetch("/api/v1/wallet/withdrawals", {
        method: "POST",
        headers: { "idempotency-key": newIdempotencyKey("WITHDRAW") },
        body: JSON.stringify(body),
      });
      setDialog(null);
      showToast("Permintaan withdrawal tercatat dan menunggu proses.");
      refresh();
    } catch (caught) { showToast(errorText(caught), "error"); }
    finally { setBusy(false); }
  }

  async function markRead(item: AppNotification) {
    if (item.readAt) return;
    try {
      await apiFetch(`/api/v1/notifications/${item.id}/read`, { method: "POST", body: JSON.stringify({}) });
      setNotifications((current) => current.map((notification) => notification.id === item.id ? { ...notification, readAt: new Date().toISOString() } : notification));
    } catch (caught) { showToast(errorText(caught), "error"); }
  }

  async function logout() {
    setBusy(true);
    try {
      await apiFetch("/api/v1/auth/logout", { method: "POST", body: JSON.stringify({}) });
      setData(null);
      setTab("home");
      showToast("Kamu sudah keluar dari akun.");
      refresh();
    } catch (caught) { showToast(errorText(caught), "error"); }
    finally { setBusy(false); }
  }

  async function createType(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setBusy(true);
    try {
      await apiFetch("/api/v1/admin/arisan/types", {
        method: "POST",
        body: JSON.stringify({
          name: form.get("name"),
          description: form.get("description"),
          contributionAmount: Number(form.get("amount")),
          minimumParticipants: Number(form.get("minimum")),
          maximumParticipants: Number(form.get("maximum")),
          cancellationDeadlineDays: Number(form.get("days")),
          platformFeeBps: 0,
        }),
      });
      setDialog(null);
      showToast("Jenis arisan berhasil dibuat.");
      refresh();
    } catch (caught) { showToast(errorText(caught), "error"); }
    finally { setBusy(false); }
  }

  async function createPeriod(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const toIso = (key: string) => new Date(String(form.get(key))).toISOString();
    setBusy(true);
    try {
      await apiFetch("/api/v1/admin/arisan/periods", {
        method: "POST",
        body: JSON.stringify({
          typeId: form.get("typeId"),
          code: form.get("code"),
          registrationStartsAt: toIso("starts"),
          registrationEndsAt: toIso("ends"),
          drawingAt: toIso("drawing"),
          status: "OPEN",
        }),
      });
      setDialog(null);
      showToast("Periode dibuka dan siap menerima peserta.");
      refresh();
    } catch (caught) { showToast(errorText(caught), "error"); }
    finally { setBusy(false); }
  }

  const pageTitle = tab === "home" ? "Beranda" : tab === "explore" ? "Jelajahi arisan" : tab === "mine" ? "Arisan saya" : tab === "wallet" ? "Wallet" : tab === "notifications" ? "Notifikasi" : tab === "profile" ? "Profil" : tab === "settings" ? "Pengaturan akun" : tab === "help" ? "Pusat bantuan" : "Ruang admin";

  return (
    <div className="min-h-screen bg-[#f5f7f4] text-[#17251e]">
      {user && <Sidebar tab={tab} setTab={setTab} user={user} unread={data?.unreadNotifications ?? 0} />}
      <div className={user ? "lg:pl-[252px]" : ""}>
        <header className="relative z-20 border-b border-[#e8ede8]/90 bg-[#f7f8f6]/90 backdrop-blur-xl lg:sticky lg:top-0">
          <div className="mx-auto flex h-[72px] max-w-[1440px] items-center justify-between px-4 sm:px-7 lg:px-9">
            <div className="flex items-center gap-3">
              {!user && <Brand compact />}
              {user && <div className="hidden text-sm font-semibold text-[#415248] sm:block">{pageTitle}</div>}
              {!user && <span className="hidden rounded-full border border-[#e3ebe2] bg-white px-3 py-1.5 text-[11px] font-semibold text-[#7a897f] sm:inline-flex">Arisan digital, lebih transparan</span>}
            </div>
            <div className="flex items-center gap-2.5">
              {user ? (
                <>
                  <button onClick={() => setTab("notifications")} aria-label={`Notifikasi${(data?.unreadNotifications ?? 0) > 0 ? `, ${data?.unreadNotifications} belum dibaca` : ""}`} aria-current={tab === "notifications" ? "page" : undefined} className="relative grid h-10 w-10 place-items-center rounded-full border border-[#e7ece7] bg-white text-[#506057] transition hover:bg-[#f1f5f1] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#174e40]">
                    <Icon name="bell" size={18} />
                    {(data?.unreadNotifications ?? 0) > 0 && <span className="absolute right-[8px] top-[7px] h-2 w-2 rounded-full border-2 border-white bg-[#ec8c68]" />}
                  </button>
                  <div className="relative" onKeyDown={(event) => { if (event.key === "Escape" && profileMenuOpen) { setProfileMenuOpen(false); profileTriggerRef.current?.focus(); } }}>
                    <button ref={profileTriggerRef} onClick={() => setProfileMenuOpen((open) => !open)} aria-expanded={profileMenuOpen} aria-haspopup="true" aria-label={`Menu profil, ${user.name}`} className="flex h-10 items-center gap-2 rounded-full border border-[#e7ece7] bg-white px-1.5 pr-2.5 text-left hover:bg-[#f8faf7] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#174e40]">
                      <span className="grid h-8 w-8 place-items-center rounded-full bg-[#dcebcf] text-[11px] font-bold text-[#35624a]">{initials(user.name)}</span>
                      <span className="hidden text-left sm:block"><span className="block text-[11px] font-semibold text-[#304339]">{user.name}</span><span className="block text-[9px] text-[#93a097]">{user.role === "USER" ? "Anggota" : "Administrator"}</span></span>
                      <Icon name="chevron" size={13} className="hidden rotate-90 text-[#829087] sm:block" />
                    </button>
                    {profileMenuOpen && <div className="absolute right-0 top-12 z-40 w-56 rounded-2xl border border-[#e5ebe5] bg-white p-2 shadow-xl" aria-label="Menu profil">
                      <div className="border-b border-[#edf0ed] px-3 py-2"><p className="truncate text-xs font-semibold text-[#304339]">{user.name}</p>{user.email && <p className="truncate text-[10px] text-[#89968d]">{user.email}</p>}</div>
                      <button onClick={() => { setTab("settings"); setProfileMenuOpen(false); }} className="w-full rounded-lg px-3 py-2.5 text-left text-xs font-medium text-[#506057] hover:bg-[#f5f8f3]">Pengaturan akun</button>
                      <button onClick={() => { setTab("profile"); setProfileMenuOpen(false); }} className="w-full rounded-lg px-3 py-2.5 text-left text-xs font-medium text-[#506057] hover:bg-[#f5f8f3]">Profil</button>
                      <button onClick={() => { setTab("notifications"); setProfileMenuOpen(false); }} className="flex w-full items-center justify-between rounded-lg px-3 py-2.5 text-left text-xs font-medium text-[#506057] hover:bg-[#f5f8f3]">Notifikasi{(data?.unreadNotifications ?? 0) > 0 && <span className="rounded-full bg-[#e8f3e4] px-2 py-0.5 text-[9px] text-[#548059]">{data?.unreadNotifications} baru</span>}</button>
                      <button onClick={() => { setTab("help"); setProfileMenuOpen(false); }} className="w-full rounded-lg px-3 py-2.5 text-left text-xs font-medium text-[#506057] hover:bg-[#f5f8f3]">Pusat bantuan</button>
                      <div className="my-1 border-t border-[#edf0ed]" />
                      <button onClick={() => { setProfileMenuOpen(false); void logout(); }} className="w-full rounded-lg px-3 py-2.5 text-left text-xs font-semibold text-[#a65b4e] hover:bg-[#fff5f2]">Keluar</button>
                    </div>}
                  </div>
                </>
              ) : (
                <div className="flex items-center gap-2">
                  <Link href="/login" className="rounded-full px-4 py-2.5 text-xs font-semibold text-[#526258] hover:bg-white">Masuk</Link>
                  <Link href="/register" className="rounded-full bg-[#174e40] px-4 py-2.5 text-xs font-semibold text-white transition hover:bg-[#103b30]">Buat akun</Link>
                </div>
              )}
            </div>
          </div>
        </header>

        <main className={`mx-auto max-w-[1440px] px-4 pb-28 pt-6 sm:px-7 sm:pt-8 lg:px-9 ${user ? "lg:pb-10" : ""}`}>
          {loading && !data && !periods.length ? <LoadingState /> : !user ? (
            <GuestLanding periods={periods} error={error} onJoin={() => router.push("/login")} onRegister={() => router.push("/register")} />
          ) : (
            <>
              <div className="mb-7 flex items-end justify-between gap-4 animate-fade-up">
                <div><p className="text-xs font-medium text-[#89968d]">{new Intl.DateTimeFormat("id-ID", { weekday: "long", day: "numeric", month: "long" }).format(new Date())}</p><h1 className="mt-1 text-[26px] font-semibold tracking-[-.04em] text-[#17251e] sm:text-[30px]">{tab === "home" ? `Halo, ${user.name.split(" ")[0]}` : pageTitle}<span className="text-[#9aba73]">.</span></h1><p className="mt-1 text-sm text-[#87948b]">{tab === "home" ? "Siap melihat kabar arisanmu hari ini?" : subtitleFor(tab)}</p></div>
                <div className="hidden items-center gap-2 rounded-full border border-[#e4ebe4] bg-white px-3 py-2 text-[11px] font-semibold text-[#718078] sm:flex"><span className="h-2 w-2 rounded-full bg-[#6fb37c]" /> Semua layanan normal</div>
              </div>
              {error && <Notice message={error} onDismiss={() => setError("")} />}
              {tab === "home" && <HomeView data={data} periods={periods} memberships={activeMemberships} onExplore={() => setTab("explore")} onMine={() => setTab("mine")} onTopup={openTopup} onWithdraw={() => setDialog({ kind: "withdraw" })} onJoin={openJoin} onCancel={(membership) => setDialog({ kind: "cancel", membership })} />}
              {tab === "explore" && <ExploreView periods={filteredPeriods} search={search} setSearch={setSearch} memberships={data?.memberships ?? []} available={wallet.availableBalance} onJoin={openJoin} />}
              {tab === "mine" && <MineView memberships={data?.memberships ?? []} onCancel={(membership) => setDialog({ kind: "cancel", membership })} />}
              {tab === "wallet" && <WalletView wallet={wallet} transactions={transactions.length ? transactions : data?.recentTransactions ?? []} onTopup={openTopup} onWithdraw={() => setDialog({ kind: "withdraw" })} />}
              {tab === "notifications" && <NotificationView notifications={notifications} onRead={markRead} />}
              {tab === "profile" && <ProfileView user={user} />}
              {tab === "settings" && <AccountSettingsView user={user} />}
              {tab === "help" && <HelpView />}
              {tab === "admin" && (user.role === "ADMIN" || user.role === "SUPER_ADMIN") && <AdminView metrics={adminMetrics} types={adminTypes} periods={adminPeriods} onNewType={() => setDialog({ kind: "create-type" })} onNewPeriod={() => setDialog({ kind: "create-period" })} onDraw={async (periodId) => {
                if (!window.confirm("Jalankan drawing dan settlement periode ini sekarang? Proses ini tidak dapat dibatalkan.")) return;
                try { const response = await apiFetch(`/api/v1/admin/arisan/periods/${periodId}/draw`, { method: "POST", body: JSON.stringify({}) }); showToast(response.message); refresh(); }
                catch (caught) { showToast(errorText(caught), "error"); }
              }} />}
            </>
          )}
        </main>
      </div>

      {user && <MobileNav tab={tab} setTab={setTab} isAdmin={user.role !== "USER"} />}
      {toast && <div role="status" className={`fixed bottom-24 left-1/2 z-50 flex max-w-[calc(100%-28px)] -translate-x-1/2 items-center gap-2.5 rounded-2xl px-4 py-3 text-sm font-medium text-white shadow-xl sm:bottom-8 ${toast.kind === "error" ? "bg-[#a74f44]" : "bg-[#183f33]"}`}><Icon name={toast.kind === "success" ? "check" : "info"} size={18} />{toast.text}</div>}
      {dialog && <DialogLayer dialog={dialog} busy={busy} availableBalance={wallet.availableBalance} types={adminTypes} topupPayment={topupPayment} pendingJoinPeriod={pendingJoinPeriod} joinError={joinError} onClose={() => !busy && setDialog(null)} onJoin={confirmJoin} onCancel={confirmCancel} onTopup={submitTopup} onWithdraw={submitWithdrawal} onCreateType={createType} onCreatePeriod={createPeriod} onOpenTopup={() => { if (dialog.kind === "join") setPendingJoinPeriod(dialog.period); openTopup(); }} onReconcileTopup={reconcileTopup} onReturnToJoin={() => { if (pendingJoinPeriod) { setJoinError(""); setDialog({ kind: "join", period: pendingJoinPeriod }); } }} />}
    </div>
  );
}

function Brand({ compact = false }: { compact?: boolean }) {
  return <Link href="/" className={`flex items-center gap-2.5 font-bold tracking-[-.045em] text-[#183f33] ${compact ? "text-[17px]" : "text-[18px]"}`}><span className="grid h-9 w-9 place-items-center rounded-[13px] bg-[#d8edbd] text-[#23513b]"><Icon name="sparkles" size={19} /></span>seearisan<span className="-ml-2 text-[#a1c17c]">.</span></Link>;
}

function Sidebar({ tab, setTab, user, unread }: { tab: Tab; setTab: (tab: Tab) => void; user: User; unread: number }) {
  return (
    <aside className="fixed inset-y-0 left-0 z-30 hidden w-[252px] flex-col border-r border-[#e8ede8] bg-white px-5 py-6 lg:flex">
      <div className="px-1"><Brand /></div>
      <div className="mt-11 px-3 text-[10px] font-bold uppercase tracking-[.15em] text-[#a2aca4]">Menu utama</div>
      <nav className="mt-3 space-y-1">
        {navigation.map((item) => <NavButton key={item.key} item={item} active={tab === item.key} unread={item.key === "notifications" ? unread : 0} onClick={() => setTab(item.key)} />)}
        {(user.role === "ADMIN" || user.role === "SUPER_ADMIN") && <div className="pt-5"><div className="mb-3 px-3 text-[10px] font-bold uppercase tracking-[.15em] text-[#a2aca4]">Manajemen</div><NavButton item={{ key: "admin", label: "Ruang admin", icon: "settings" }} active={tab === "admin"} onClick={() => setTab("admin")} /></div>}
      </nav>
      <div className="mt-auto">
        <div className="rounded-[19px] bg-[#f2f6ef] p-4"><div className="flex h-9 w-9 items-center justify-center rounded-xl bg-white text-[#46735a]"><Icon name="shield" size={18} /></div><p className="mt-3 text-xs font-semibold text-[#30483a]">Dana lebih terjaga</p><p className="mt-1 text-[10px] leading-4 text-[#819086]">Saldo terkunci dan available selalu dipisahkan.</p></div>
      </div>
    </aside>
  );
}

function NavButton({ item, active, unread = 0, onClick }: { item: { key: Tab; label: string; icon: IconName }; active: boolean; unread?: number; onClick: () => void }) {
  return <button onClick={onClick} className={`group flex w-full items-center gap-3 rounded-[13px] px-3 py-[11px] text-left text-[12px] font-semibold transition ${active ? "bg-[#eaf2e5] text-[#22513c]" : "text-[#7b8980] hover:bg-[#f6f8f5] hover:text-[#385947]"}`}><Icon name={item.icon} size={18} className={active ? "text-[#4f815d]" : "text-[#9ba69e] group-hover:text-[#5f8069]"} /><span className="flex-1">{item.label}</span>{unread > 0 && <span className="grid h-5 min-w-5 place-items-center rounded-full bg-[#ddedcf] px-1 text-[9px] font-bold text-[#47704d]">{unread > 9 ? "9+" : unread}</span>}</button>;
}

function MobileNav({ tab, setTab, isAdmin }: { tab: Tab; setTab: (tab: Tab) => void; isAdmin: boolean }) {
  return <nav aria-label="Navigasi utama" className="fixed inset-x-0 bottom-0 z-30 grid grid-cols-3 border-t border-[#e7ece7] bg-white/95 px-1 pb-[max(9px,env(safe-area-inset-bottom))] pt-2 backdrop-blur-xl lg:hidden">
    {navigation.map((item) => <button key={item.key} onClick={() => setTab(item.key)} aria-current={tab === item.key ? "page" : undefined} className={`relative flex flex-col items-center gap-1 py-1.5 text-[10px] font-semibold focus-visible:outline focus-visible:outline-2 focus-visible:outline-[#174e40] ${tab === item.key ? "text-[#286047]" : "text-[#a0aaa2]"}`}><span className={`grid h-8 w-10 place-items-center rounded-full ${tab === item.key ? "bg-[#ecf4e6]" : ""}`}><Icon name={item.icon} size={18} /></span>{item.label === "Jelajahi arisan" ? "Jelajahi" : item.label}</button>)}
    {isAdmin && <button onClick={() => setTab("admin")} className={`absolute right-2 top-[-47px] grid h-10 w-10 place-items-center rounded-full border border-[#dfe8df] bg-white text-[#477356] shadow-sm ${tab === "admin" ? "bg-[#eaf2e5]" : ""}`} aria-label="Ruang admin"><Icon name="settings" size={18} /></button>}
  </nav>;
}

function HomeView({ data, periods, memberships, onExplore, onMine, onTopup, onWithdraw, onJoin, onCancel }: { data: DashboardData | null; periods: Period[]; memberships: Membership[]; onExplore: () => void; onMine: () => void; onTopup: () => void; onWithdraw: () => void; onJoin: (period: Period) => void; onCancel: (membership: Membership) => void }) {
  const wallet = data?.wallet ?? { availableBalance: 0, lockedBalance: 0, pendingBalance: 0, totalBalance: 0 };
  const nextDrawing = memberships.filter((item) => item.participantStatus === "ACTIVE").sort((a, b) => new Date(a.drawingAt).getTime() - new Date(b.drawingAt).getTime())[0];
  const openPeriods = periods.filter((period) => period.status === "OPEN").slice(0, 3);
  return <div className="animate-fade-up">
    <section className="relative overflow-hidden rounded-[25px] bg-[#143e33] p-5 text-white shadow-[0_15px_40px_rgba(18,57,45,.12)] sm:rounded-[29px] sm:p-7 lg:p-8">
      <div className="absolute -right-16 -top-28 h-80 w-80 rounded-full border border-white/[.08]" /><div className="absolute -right-3 -top-16 h-56 w-56 rounded-full border border-white/[.08]" /><div className="absolute -bottom-32 right-[30%] h-52 w-52 rounded-full bg-[#afd881]/[.08] blur-3xl" />
      <div className="relative z-10 grid gap-7 lg:grid-cols-[1.15fr_.85fr] lg:items-end">
        <div><div className="flex items-center gap-2 text-[11px] font-medium text-white/65"><span className="grid h-7 w-7 place-items-center rounded-lg bg-white/10 text-[#d6efb1]"><Icon name="wallet" size={15} /></span> Ringkasan saldo</div><p className="mt-5 text-xs font-medium text-white/65">Saldo tersedia</p><div className="mt-1 flex flex-wrap items-end gap-x-3 gap-y-2"><p className="text-[34px] font-semibold tracking-[-.05em] sm:text-[42px]">{formatIDR(wallet.availableBalance)}</p><span className="mb-1 rounded-full border border-white/15 bg-white/[.07] px-2.5 py-1 text-[10px] text-white/70">Total {formatIDR(wallet.totalBalance)}</span></div>
          <div className="mt-6 flex flex-wrap gap-2.5"><button onClick={onTopup} className="inline-flex items-center gap-2 rounded-xl bg-[#c9ec96] px-4 py-3 text-xs font-bold text-[#1e4734] transition hover:bg-[#d7f4ad]"><Icon name="plus" size={17} />Top up saldo</button><button onClick={onWithdraw} className="inline-flex items-center gap-2 rounded-xl border border-white/15 bg-white/[.06] px-4 py-3 text-xs font-semibold text-white/90 transition hover:bg-white/10"><Icon name="arrowUp" size={15} />Tarik saldo</button></div>
        </div>
        <div className="grid grid-cols-2 gap-2.5 sm:gap-3"><BalanceTile label="Dana terkunci" amount={wallet.lockedBalance} icon="lock" description="Iuran aktif" /><BalanceTile label="Dana pending" amount={wallet.pendingBalance} icon="clock" description="Menunggu proses" /></div>
      </div>
    </section>

    <div className="mt-7 grid gap-6 xl:grid-cols-[1.35fr_.65fr]">
      <section>
        <div className="mb-3 flex items-center justify-between"><div><h2 className="text-[16px] font-semibold tracking-[-.02em]">Arisan aktifmu</h2><p className="mt-1 text-[11px] text-[#8b978f]">Pantau periode yang sedang kamu ikuti</p></div><button onClick={onMine} className="flex items-center gap-1 text-[11px] font-semibold text-[#477758] hover:text-[#183f33]">Lihat riwayat <Icon name="chevron" size={14} /></button></div>
        {memberships.length ? <div className="space-y-3">{memberships.slice(0, 3).map((membership) => <MembershipCard key={membership.participantId} membership={membership} onCancel={() => onCancel(membership)} compact />)}</div> : <EmptyCard icon="calendar" title="Belum ada arisan aktif" text="Jelajahi periode yang sedang dibuka dan temukan yang cocok untukmu." action="Jelajahi arisan" onClick={onExplore} />}
      </section>
      <aside className="space-y-4">
        <section className="rounded-[22px] border border-[#e7ece7] bg-white p-5 sm:p-6"><div className="flex items-center justify-between"><span className="text-[11px] font-semibold text-[#849188]">Jadwal terdekat</span><span className="grid h-8 w-8 place-items-center rounded-xl bg-[#f0f5eb] text-[#668250]"><Icon name="calendar" size={16} /></span></div>{nextDrawing ? <><h3 className="mt-3 text-[15px] font-semibold text-[#273c30]">{nextDrawing.name}</h3><p className="mt-1 text-[11px] text-[#8b978f]">{nextDrawing.periodCode}</p><div className="mt-4 flex items-center gap-2 rounded-xl bg-[#f6f8f4] px-3 py-3"><Icon name="clock" size={16} className="text-[#8aa16f]" /><div className="flex-1"><p className="text-[10px] text-[#8d9990]">Pemilihan pemenang</p><p className="mt-0.5 text-xs font-semibold text-[#385442]">{formatDateTime(nextDrawing.drawingAt)} WIB</p></div><span className="rounded-full bg-[#e4f0d9] px-2 py-1 text-[10px] font-bold text-[#51754e]">H-{daysRemaining(nextDrawing.drawingAt)}</span></div></> : <><h3 className="mt-3 text-[15px] font-semibold text-[#273c30]">Belum ada jadwal</h3><p className="mt-1 text-xs leading-5 text-[#8b978f]">Periode yang kamu ikuti akan muncul di sini.</p></>}</section>
        <section className="relative overflow-hidden rounded-[22px] bg-[#e7f0df] p-5"><div className="absolute -right-7 -top-9 h-28 w-28 rounded-full border border-[#ccdfbd]" /><div className="relative flex items-start gap-3"><span className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-white/80 text-[#5b8152]"><Icon name="shield" size={18} /></span><div><p className="text-xs font-semibold text-[#35533b]">Transparan sejak awal</p><p className="mt-1 text-[10px] leading-4 text-[#718771]">Saldo iuran dikunci terpisah dan setiap perubahan tercatat di riwayat.</p></div></div></section>
      </aside>
    </div>

    <section className="mt-8"><div className="mb-3 flex items-center justify-between"><div><h2 className="text-[16px] font-semibold tracking-[-.02em]">Periode yang dibuka</h2><p className="mt-1 text-[11px] text-[#8b978f]">Pilih iuran dan jadwal yang sesuai</p></div><button onClick={onExplore} className="flex items-center gap-1 text-[11px] font-semibold text-[#477758]">Jelajahi semua <Icon name="chevron" size={14} /></button></div>{openPeriods.length ? <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">{openPeriods.map((period) => <PeriodCard key={period.id} period={period} onJoin={() => onJoin(period)} joined={memberships.some((membership) => membership.periodId === period.id)} />)}</div> : <EmptyCard icon="users" title="Belum ada periode terbuka" text="Periode baru akan muncul di sini setelah admin membukanya." action="Lihat katalog" onClick={onExplore} />}</section>
  </div>;
}

function BalanceTile({ label, amount, icon, description }: { label: string; amount: number; icon: IconName; description: string }) {
  return <div className="rounded-[17px] border border-white/10 bg-white/[.06] p-3.5 sm:p-4"><div className="flex items-center gap-2 text-[10px] font-medium text-white/65"><Icon name={icon} size={14} className="text-[#d4e9bd]" />{label}</div><p className="mt-3 text-[16px] font-semibold tracking-[-.03em] sm:text-[19px]">{formatIDR(amount)}</p><p className="mt-1 text-[9px] text-white/45">{description}</p></div>;
}

function ExploreView({ periods, search, setSearch, memberships, available, onJoin }: { periods: Period[]; search: string; setSearch: (value: string) => void; memberships: Membership[]; available: number; onJoin: (period: Period) => void }) {
  return <section className="animate-fade-up"><div className="mb-5 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between"><div><h2 className="text-[16px] font-semibold">Pilihan periode arisan</h2><p className="mt-1 text-[11px] text-[#89968d]">Informasi jadwal dan iuran yang ditetapkan admin.</p></div><label className="flex h-10 items-center gap-2 rounded-xl border border-[#e5ebe5] bg-white px-3 sm:w-[270px]"><Icon name="search" size={16} aria-hidden="true" className="text-[#a0aaa2]" /><span className="sr-only">Cari arisan berdasarkan nama atau kode</span><input aria-label="Cari arisan berdasarkan nama atau kode" type="search" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Cari arisan atau kode…" className="w-full bg-transparent text-xs outline-none placeholder:text-[#a2aca4]" /></label></div><div className="mb-4 flex items-center gap-2 rounded-xl border border-[#e5ece3] bg-[#f1f6ee] px-3.5 py-3 text-[11px] text-[#61775f]"><Icon name="info" size={16} aria-hidden="true" />Saldo tersedia saat ini: <strong className="font-semibold text-[#385a3e]">{formatIDR(available)}</strong><span className="hidden text-[#899989] sm:inline">— saldo terkunci tidak dapat digunakan untuk join.</span></div><p className="sr-only" aria-live="polite">{periods.length} periode ditemukan</p>{periods.length ? <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">{periods.map((period) => { const joined = memberships.some((item) => item.periodId === period.id); return <PeriodCard key={period.id} period={period} joined={joined} onJoin={() => onJoin(period)} />; })}</div> : <EmptyCard icon="search" title="Tidak ada periode ditemukan" text="Coba kata kunci lain atau periksa kembali nanti." />}</section>;
}

function PeriodCard({ period, joined, onJoin }: { period: Period; joined: boolean; onJoin: () => void }) {
  const full = period.participantCount >= period.maximumParticipants || period.status === "FULL";
  const now = new Date().getTime();
  const startsAt = new Date(period.registrationStartsAt).getTime();
  const endsAt = new Date(period.registrationEndsAt).getTime();
  const isOpen = period.status === "OPEN" && now >= startsAt && now <= endsAt;
  const registrationReason = full ? "Kuota peserta sudah terpenuhi." : period.status === "FULL" ? "Kuota peserta sudah penuh." : period.status === "LOCKED" ? "Pendaftaran berakhir; periode menunggu drawing." : period.status === "DRAWING" || period.status === "PAYOUT_PROCESSING" ? "Periode sedang diproses." : period.status === "COMPLETED" ? "Periode telah selesai." : period.status === "CANCELLED" ? "Periode dibatalkan." : now < startsAt ? `Pendaftaran dibuka ${formatDateTime(period.registrationStartsAt)} WIB.` : now > endsAt ? `Pendaftaran ditutup ${formatDateTime(period.registrationEndsAt)} WIB.` : "";
  return <article className="flex flex-col rounded-[20px] border border-[#e6ece6] bg-white p-4.5 p-5 transition hover:border-[#d4e1d3] hover:shadow-[0_12px_28px_rgba(34,60,43,.045)]"><div className="flex items-start justify-between gap-3"><span className="grid h-10 w-10 place-items-center rounded-[14px] bg-[#eff5e9] text-[#5f8150]"><Icon name="users" size={18} aria-hidden="true" /></span><StatusBadge status={full ? "FULL" : period.status} /></div><p className="mt-4 text-[10px] font-semibold uppercase tracking-[.12em] text-[#96a198]">{period.code}</p><h3 className="mt-1 text-[16px] font-semibold tracking-[-.025em] text-[#243b2e]">{period.name}</h3><p className="mt-1 line-clamp-2 min-h-8 text-[10px] leading-4 text-[#929d95]">{period.description || "Iuran dikunci sampai proses drawing selesai."}</p><div className="mt-4 flex items-end justify-between border-t border-[#eef1ee] pt-3.5"><div><p className="text-[9px] font-medium text-[#9aa49c]">Iuran per peserta</p><p className="mt-1 text-[17px] font-semibold tracking-[-.03em] text-[#294d38]">{formatIDR(period.contributionAmount)}</p></div><div className="text-right"><p className="text-[9px] text-[#9aa49c]">Peserta</p><p className="mt-1 text-xs font-semibold text-[#607168]">{period.participantCount}<span className="font-medium text-[#a3ada5">/{period.maximumParticipants}</span></p></div></div><div className="mt-3 rounded-xl bg-[#f7f9f6] px-3 py-2.5"><div className="flex items-center justify-between"><div className="flex items-center gap-2 text-[10px] text-[#8a968d]"><Icon name="calendar" size={14} className="text-[#89a16f]" />Drawing</div><span className="text-[10px] font-semibold text-[#536b59]">{formatDate(period.drawingAt)}</span></div><p className="mt-2 text-[9px] leading-4 text-[#829087]">Pendaftaran: {formatDateTime(period.registrationStartsAt)} – {formatDateTime(period.registrationEndsAt)} WIB</p></div>{registrationReason && !joined && <p className="mt-2 text-[10px] leading-4 text-[#77857b]">{registrationReason}</p>}<button onClick={onJoin} disabled={!isOpen || full || joined} aria-describedby={!isOpen || full ? `period-${period.id}-reason` : undefined} className={`mt-3 flex h-10 w-full items-center justify-center gap-2 rounded-xl text-[11px] font-semibold transition disabled:cursor-not-allowed ${joined ? "bg-[#eef4e9] text-[#65805f]" : isOpen && !full ? "bg-[#174e40] text-white hover:bg-[#103c31]" : "bg-[#f1f3f0] text-[#9ba49d]"}`}>{joined ? "Sudah bergabung" : full ? "Kuota penuh" : isOpen ? "Lihat konfirmasi & gabung" : "Belum dapat bergabung"}{isOpen && !full && !joined && <Icon name="arrowRight" size={15} />}</button>{registrationReason && !joined && <span id={`period-${period.id}-reason`} className="sr-only">{registrationReason}</span>}</article>;
}

function MineView({ memberships, onCancel }: { memberships: Membership[]; onCancel: (membership: Membership) => void }) {
  return <section className="animate-fade-up"><div className="mb-5 flex items-center justify-between"><div><h2 className="text-[16px] font-semibold">Riwayat kepesertaan</h2><p className="mt-1 text-[11px] text-[#89968d]">Status dan jadwal setiap periode yang kamu ikuti.</p></div><span className="rounded-full bg-[#edf3e8] px-3 py-1.5 text-[10px] font-semibold text-[#5e7b58]">{memberships.length} periode</span></div>{memberships.length ? <div className="space-y-3">{memberships.map((membership) => <MembershipCard key={membership.participantId} membership={membership} onCancel={() => onCancel(membership)} />)}</div> : <EmptyCard icon="calendar" title="Belum ada kepesertaan" text="Saat bergabung, periode arisan akan tersimpan di sini." />}</section>;
}

function MembershipCard({ membership, onCancel, compact = false }: { membership: Membership; onCancel: () => void; compact?: boolean }) {
  const active = membership.participantStatus === "ACTIVE";
  const canCancel = active && new Date() <= new Date(membership.cancellationDeadlineAt) && !["DRAWING", "PAYOUT_PROCESSING", "COMPLETED", "CANCELLED"].includes(membership.periodStatus);
  return <article className={`rounded-[20px] border border-[#e6ece6] bg-white ${compact ? "p-4" : "p-5 sm:p-6"}`}><div className="flex flex-wrap items-start justify-between gap-4"><div className="flex min-w-0 items-start gap-3"><span className={`grid h-10 w-10 shrink-0 place-items-center rounded-[14px] ${membership.participantStatus === "WINNER" ? "bg-[#f8f0d9] text-[#a58136]" : "bg-[#eff5e9] text-[#608255]"}`}><Icon name={membership.participantStatus === "WINNER" ? "trophy" : "users"} size={18} /></span><div className="min-w-0"><p className="text-[10px] font-semibold uppercase tracking-[.1em] text-[#9aa59d]">{membership.periodCode}</p><h3 className="mt-1 truncate text-[15px] font-semibold text-[#2a4033]">{membership.name}</h3><div className="mt-1 text-[10px] text-[#8e9a91]">Iuran {formatIDR(membership.contributionAmount)}</div></div></div><StatusBadge status={membership.participantStatus === "ACTIVE" ? membership.periodStatus === "LOCKED" ? "LOCKED" : "ACTIVE" : membership.participantStatus} /></div><div className={`mt-4 grid grid-cols-2 gap-2.5 ${compact ? "" : "sm:grid-cols-3"}`}><InfoTile label="Pemilihan pemenang" value={formatDateTime(membership.drawingAt)} icon="calendar" /><InfoTile label="Batas pembatalan" value={formatDateTime(membership.cancellationDeadlineAt)} icon="clock" />{!compact && <InfoTile label="Peserta aktif" value={`${membership.participantCount} peserta`} icon="users" />}</div>{active && <div className="mt-3 flex flex-wrap items-center justify-between gap-3 rounded-xl bg-[#f8faf7] px-3.5 py-3"><p className="text-[10px] leading-4 text-[#7d8a80]">{canCancel ? `Pembatalan tersedia hingga ${formatDateTime(membership.cancellationDeadlineAt)} WIB.` : "Kepesertaan terkunci; pembatalan sudah ditutup."}</p><button disabled={!canCancel} onClick={onCancel} className="rounded-lg border border-[#eedbd5] px-3 py-2 text-[10px] font-semibold text-[#a86556] transition hover:bg-[#fff5f2] disabled:cursor-not-allowed disabled:border-[#e9ece8] disabled:text-[#afb7b0]">Batalkan</button></div>}</article>;
}

function WalletView({ wallet, transactions, onTopup, onWithdraw }: { wallet: Wallet; transactions: Transaction[]; onTopup: () => void; onWithdraw: () => void }) {
  return <section className="animate-fade-up"><div className="grid gap-3 sm:grid-cols-3"><WalletSummary title="Saldo tersedia" amount={wallet.availableBalance} icon="wallet" color="green" /><WalletSummary title="Saldo terkunci" amount={wallet.lockedBalance} icon="lock" color="sand" /><WalletSummary title="Saldo pending" amount={wallet.pendingBalance} icon="clock" color="blue" /></div><div className="mt-5 flex flex-wrap gap-2"><button onClick={onTopup} className="flex h-10 items-center gap-2 rounded-xl bg-[#174e40] px-4 text-[11px] font-semibold text-white hover:bg-[#103c31]"><Icon name="plus" size={16} />Top up saldo</button><button onClick={onWithdraw} className="flex h-10 items-center gap-2 rounded-xl border border-[#e1e8e1] bg-white px-4 text-[11px] font-semibold text-[#4a6352] hover:bg-[#f7f9f6]"><Icon name="arrowUp" size={15} />Ajukan withdrawal</button></div><section className="mt-7 overflow-hidden rounded-[21px] border border-[#e6ece6] bg-white"><div className="flex items-center justify-between border-b border-[#edf0ed] px-5 py-4"><div><h2 className="text-[14px] font-semibold">Riwayat transaksi</h2><p className="mt-1 text-[10px] text-[#96a198]">Semua pergerakan yang tercatat di wallet</p></div><span className="rounded-full bg-[#f2f5f1] px-2.5 py-1 text-[9px] font-semibold text-[#819087]">Ledger</span></div>{transactions.length ? <div className="divide-y divide-[#f0f2ef]">{transactions.map((transaction) => <TransactionRow key={transaction.id} transaction={transaction} />)}</div> : <div className="px-5 py-12 text-center"><span className="mx-auto grid h-11 w-11 place-items-center rounded-2xl bg-[#f1f5ef] text-[#809379]"><Icon name="card" size={19} /></span><p className="mt-3 text-xs font-semibold text-[#536459]">Belum ada transaksi</p><p className="mt-1 text-[10px] text-[#99a49c]">Aktivitas wallet akan tampil di sini.</p></div>}</section></section>;
}

function WalletSummary({ title, amount, icon, color }: { title: string; amount: number; icon: IconName; color: string }) {
  const colors = color === "green" ? "bg-[#eaf3e4] text-[#54805a]" : color === "sand" ? "bg-[#f5f0e3] text-[#a48a51]" : "bg-[#e9f1f4] text-[#5d8790]";
  return <div className="rounded-[19px] border border-[#e6ece6] bg-white p-4.5 p-5"><div className="flex items-center justify-between"><span className="text-[10px] font-semibold text-[#89968d]">{title}</span><span className={`grid h-8 w-8 place-items-center rounded-xl ${colors}`}><Icon name={icon} size={16} /></span></div><p className="mt-4 text-[21px] font-semibold tracking-[-.04em] text-[#294334]">{formatIDR(amount)}</p><p className="mt-1 text-[9px] text-[#a1aaa3]">IDR · Rupiah</p></div>;
}

function TransactionRow({ transaction }: { transaction: Transaction }) {
  const credit = transaction.direction === "CREDIT";
  const icon = transaction.type === "JOIN_ARISAN" ? "users" : transaction.type === "PAYOUT" ? "trophy" : transaction.type === "WITHDRAW" ? "arrowUp" : transaction.type === "TOPUP" ? "arrowDown" : "refresh";
  return <div className="flex items-center gap-3 px-4 py-3.5 sm:px-5"><span className={`grid h-9 w-9 shrink-0 place-items-center rounded-xl ${credit ? "bg-[#edf5e8] text-[#5a8556]" : "bg-[#f3f4f1] text-[#808d84]"}`}><Icon name={icon} size={16} /></span><div className="min-w-0 flex-1"><p className="truncate text-[11px] font-semibold text-[#405247]">{transaction.description}</p><p className="mt-1 text-[9px] text-[#9aa59d]">{formatDateTime(transaction.createdAt)} · {transaction.status}</p></div><p className={`shrink-0 text-[12px] font-semibold ${credit ? "text-[#4e8157]" : "text-[#56675d]"}`}>{credit ? "+" : "−"}{formatIDR(transaction.amount)}</p></div>;
}

function NotificationView({ notifications, onRead }: { notifications: AppNotification[]; onRead: (notification: AppNotification) => void }) {
  return <section className="animate-fade-up"><div className="mb-4"><h2 className="text-[16px] font-semibold">Pusat notifikasi</h2><p className="mt-1 text-[11px] text-[#89968d]">Pembaruan kepesertaan dan aktivitas wallet.</p></div><div className="overflow-hidden rounded-[21px] border border-[#e6ece6] bg-white">{notifications.length ? <div className="divide-y divide-[#f0f2ef]">{notifications.map((item) => <button key={item.id} onClick={() => onRead(item)} className={`flex w-full gap-3 px-4 py-4 text-left transition hover:bg-[#fafbf9] sm:px-5 ${item.readAt ? "" : "bg-[#f7faf5]"}`}><span className={`mt-0.5 grid h-9 w-9 shrink-0 place-items-center rounded-xl ${item.readAt ? "bg-[#f1f3f0] text-[#939f96]" : "bg-[#e7f1dd] text-[#5b8055]"}`}><Icon name={item.type.includes("PAYOUT") || item.type.includes("WINNER") ? "trophy" : item.type.includes("WITHDRAW") || item.type.includes("TOPUP") ? "wallet" : "bell"} size={16} /></span><span className="min-w-0 flex-1"><span className="flex items-center gap-2 text-[11px] font-semibold text-[#415247]">{item.title}{!item.readAt && <span className="h-1.5 w-1.5 rounded-full bg-[#77a764]" />}</span><span className="mt-1 block text-[10px] leading-5 text-[#839087]">{item.message}</span><span className="mt-1.5 block text-[9px] text-[#a0aaa3]">{formatDateTime(item.createdAt)}</span></span></button>)}</div> : <div className="px-5 py-14 text-center"><span className="mx-auto grid h-12 w-12 place-items-center rounded-2xl bg-[#f1f5ef] text-[#83947f]"><Icon name="bell" size={20} /></span><p className="mt-3 text-xs font-semibold text-[#526257]">Belum ada notifikasi</p><p className="mt-1 text-[10px] text-[#9aa49c]">Kami akan memberi kabar tentang aktivitasmu.</p></div>}</div></section>;
}

function ProfileView({ user }: { user: User }) {
  return <section className="animate-fade-up max-w-2xl"><div className="rounded-[22px] border border-[#e6ece6] bg-white p-5 sm:p-7"><div className="flex items-center gap-4"><span className="grid h-14 w-14 place-items-center rounded-full bg-[#dcebcf] text-lg font-bold text-[#35624a]">{initials(user.name)}</span><div><h2 className="text-lg font-semibold text-[#263d30]">{user.name}</h2><p className="mt-1 text-xs text-[#839087]">{user.role === "USER" ? "Anggota seearisan" : "Administrator"}</p></div></div><dl className="mt-6 divide-y divide-[#edf0ed] rounded-xl border border-[#edf0ed] px-4">{user.email && <div className="py-3"><dt className="text-[10px] text-[#89968d]">Email</dt><dd className="mt-1 text-sm font-medium text-[#405247]">{user.email}</dd></div>}<div className="py-3"><dt className="text-[10px] text-[#89968d]">Nomor HP terverifikasi</dt><dd className="mt-1 text-sm font-medium text-[#405247]">{user.phone}</dd></div></dl><p className="mt-4 text-[11px] leading-5 text-[#87948b]">Data profil ditampilkan sesuai informasi akun terdaftar.</p></div></section>;
}

function AccountSettingsView({ user }: { user: User }) {
  return <section className="animate-fade-up max-w-2xl"><div className="rounded-[22px] border border-[#e6ece6] bg-white p-5 sm:p-7"><h2 className="text-base font-semibold text-[#263d30]">Pengaturan akun</h2><p className="mt-1 text-xs leading-5 text-[#839087]">Kelola dan periksa informasi yang terhubung ke akunmu.</p><div className="mt-5 space-y-3"><div className="rounded-xl bg-[#f7f9f6] p-4"><p className="text-xs font-semibold text-[#405247]">Informasi masuk</p><p className="mt-1 text-[11px] leading-5 text-[#839087]">{user.email ? <>Email: {user.email}<br /></> : null}Nomor HP terverifikasi: {user.phone}</p></div><div className="rounded-xl bg-[#f7f9f6] p-4"><p className="text-xs font-semibold text-[#405247]">Keamanan akun</p><p className="mt-1 text-[11px] leading-5 text-[#839087]">Jangan bagikan password atau kode verifikasi kepada siapa pun. Untuk mengakhiri sesi, pilih Keluar dari menu profil.</p></div></div><p className="mt-4 text-[10px] leading-5 text-[#9aa49c]">Perubahan informasi akun belum tersedia di aplikasi ini.</p></div></section>;
}

function HelpView() {
  return <section className="animate-fade-up max-w-2xl"><div className="rounded-[22px] border border-[#e6ece6] bg-white p-5 sm:p-7"><h2 className="text-base font-semibold text-[#263d30]">Pusat bantuan</h2><p className="mt-1 text-xs leading-5 text-[#839087]">Jawaban singkat untuk hal yang sering ditanyakan.</p><div className="mt-5 space-y-4"><div><h3 className="text-xs font-semibold text-[#405247]">Kapan saldo top up tersedia?</h3><p className="mt-1 text-[11px] leading-5 text-[#839087]">Setelah pembayaran dikonfirmasi oleh penyedia pembayaran. Kamu dapat membuka Wallet dan memeriksa status pembayaran.</p></div><div><h3 className="text-xs font-semibold text-[#405247]">Apa arti saldo terkunci?</h3><p className="mt-1 text-[11px] leading-5 text-[#839087]">Saldo iuran yang sudah dialokasikan untuk kepesertaan aktif dan tidak dapat digunakan untuk transaksi lain.</p></div><div><h3 className="text-xs font-semibold text-[#405247]">Bagaimana membatalkan kepesertaan?</h3><p className="mt-1 text-[11px] leading-5 text-[#839087]">Buka bagian Arisan aktifmu di Beranda dan gunakan Batalkan sebelum batas waktu yang tertera.</p></div></div></div></section>;
}

function AdminView({ metrics, types, periods, onNewType, onNewPeriod, onDraw }: { metrics: AdminMetrics | null; types: TypeOption[]; periods: AdminPeriod[]; onNewType: () => void; onNewPeriod: () => void; onDraw: (id: string) => void }) {
  const [view, setView] = useState<"overview" | "types" | "periods">("overview");
  const stats = metrics ? [
    { label: "Total pengguna", value: metrics.users.totalUsers.toLocaleString("id-ID"), detail: `${metrics.users.activeUsers} aktif`, icon: "users" as const },
    { label: "Total saldo wallet", value: formatIDR(metrics.wallets.totalWalletBalance), detail: `${formatIDR(metrics.wallets.totalLockedBalance)} terkunci`, icon: "wallet" as const },
    { label: "Arisan berjalan", value: metrics.arisan.activeArisan.toLocaleString("id-ID"), detail: `${metrics.arisan.activeParticipants} peserta aktif`, icon: "calendar" as const },
    { label: "Total payout", value: formatIDR(metrics.finance.totalPayout), detail: `${metrics.arisan.completedArisan} periode selesai`, icon: "trophy" as const },
  ] : [];
  return <section className="animate-fade-up"><div className="mb-5 flex flex-wrap items-center justify-between gap-3"><div><h2 className="text-[16px] font-semibold">Ikhtisar operasional</h2><p className="mt-1 text-[11px] text-[#89968d]">Angka agregat untuk pemantauan. Saldo tidak dapat diedit langsung.</p></div><div className="flex gap-2"><button onClick={onNewType} className="flex h-9 items-center gap-1.5 rounded-xl border border-[#e2e9e1] bg-white px-3 text-[10px] font-semibold text-[#4d6653]"><Icon name="plus" size={14} />Jenis arisan</button><button onClick={onNewPeriod} className="flex h-9 items-center gap-1.5 rounded-xl bg-[#174e40] px-3 text-[10px] font-semibold text-white"><Icon name="plus" size={14} />Periode</button></div></div><div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">{stats.map((stat) => <div key={stat.label} className="rounded-[19px] border border-[#e6ece6] bg-white p-4.5 p-5"><span className="grid h-9 w-9 place-items-center rounded-xl bg-[#eff5e9] text-[#5d8051]"><Icon name={stat.icon} size={17} /></span><p className="mt-4 text-[10px] font-medium text-[#89968d]">{stat.label}</p><p className="mt-1 text-[20px] font-semibold tracking-[-.035em] text-[#2b4635]">{stat.value}</p><p className="mt-1 text-[9px] text-[#a0aaa3]">{stat.detail}</p></div>)}</div><div className="mt-6 flex gap-1 rounded-xl bg-[#eaf0e8] p-1 sm:w-fit">{([['overview','Ringkasan'],['types','Jenis arisan'],['periods','Periode']] as const).map(([key,label]) => <button key={key} onClick={() => setView(key)} className={`rounded-lg px-3.5 py-2 text-[10px] font-semibold transition ${view === key ? "bg-white text-[#375940] shadow-sm" : "text-[#879389]"}`}>{label}</button>)}</div>{view === "overview" && <div className="mt-4 grid gap-4 lg:grid-cols-2"><div className="rounded-[20px] border border-[#e6ece6] bg-white p-5"><h3 className="text-[13px] font-semibold">Ringkasan dana</h3><div className="mt-4 space-y-3">{[["Saldo tersedia",metrics?.wallets.totalAvailableBalance],["Saldo terkunci",metrics?.wallets.totalLockedBalance],["Saldo pending",metrics?.wallets.totalPendingBalance],["Top-up terverifikasi",metrics?.finance.totalTopups],["Withdrawal sukses",metrics?.finance.totalWithdrawals]].map(([label,value]) => <div key={String(label)} className="flex items-center justify-between border-b border-[#f0f2ef] pb-2.5 text-[10px] last:border-0"><span className="text-[#829087]">{label}</span><strong className="font-semibold text-[#405747]">{formatIDR(String(value ?? 0))}</strong></div>)}</div></div><div className="rounded-[20px] border border-[#e6ece6] bg-white p-5"><h3 className="text-[13px] font-semibold">Pintasan admin</h3><p className="mt-1 text-[10px] text-[#95a097]">Setiap perubahan dicatat dalam audit log.</p><div className="mt-4 space-y-2"><AdminShortcut icon="users" title="Kelola peserta" text={`${metrics?.arisan.allParticipants ?? 0} kepesertaan tercatat`} onClick={() => setView("periods")} /><AdminShortcut icon="settings" title="Konfigurasi jenis arisan" text={`${types.length} jenis terdaftar`} onClick={() => setView("types")} /><AdminShortcut icon="calendar" title="Pantau periode aktif" text={`${metrics?.arisan.activeArisan ?? 0} periode berjalan`} onClick={() => setView("periods")} /></div></div></div>}{view === "types" && <div className="mt-4 grid gap-3 md:grid-cols-2">{types.length ? types.map((type) => <div key={type.id} className="rounded-[19px] border border-[#e6ece6] bg-white p-4.5 p-5"><div className="flex justify-between"><div><p className="text-[10px] text-[#9ba59d]">{type.minimumParticipants}–{type.maximumParticipants} peserta</p><h3 className="mt-1 text-[14px] font-semibold text-[#304939]">{type.name}</h3></div><StatusBadge status={type.active ? "OPEN" : "CANCELLED"} /></div><p className="mt-3 text-[18px] font-semibold text-[#31573b]">{formatIDR(type.contributionAmount)}<span className="ml-1 text-[10px] font-medium text-[#91a096]">/ peserta</span></p><p className="mt-2 text-[9px] text-[#97a29a]">Pembatalan H-{type.cancellationDeadlineDays} · Fee {type.platformFeeBps} bps</p></div>) : <EmptyCard icon="users" title="Belum ada jenis arisan" text="Buat jenis arisan pertama untuk membuka periode." action="Buat jenis" onClick={onNewType} />}</div>}{view === "periods" && <div className="mt-4 space-y-3">{periods.length ? periods.map((period) => <article key={period.id} className="rounded-[19px] border border-[#e6ece6] bg-white p-4 sm:p-5"><div className="flex flex-wrap items-center justify-between gap-3"><div><p className="text-[9px] font-semibold uppercase tracking-[.1em] text-[#98a39b]">{period.code} · {period.name}</p><h3 className="mt-1 text-[14px] font-semibold text-[#304939]">{formatIDR(period.contributionAmount)} <span className="text-[10px] font-medium text-[#96a198]">· {period.participantCount}/{period.maximumParticipants} peserta</span></h3><p className="mt-1 text-[9px] text-[#94a097]">Drawing {formatDateTime(period.drawingAt)} · batal sampai {formatDateTime(period.cancellationDeadlineAt)}</p></div><div className="flex items-center gap-2"><StatusBadge status={period.status} />{["OPEN","FULL","LOCKED"].includes(period.status) && <button onClick={() => onDraw(period.id)} className="rounded-lg bg-[#174e40] px-3 py-2 text-[9px] font-semibold text-white hover:bg-[#103c31]">Jalankan drawing</button>}</div></div></article>) : <EmptyCard icon="calendar" title="Belum ada periode" text="Buat periode baru untuk mengelola pendaftaran dan drawing." action="Buat periode" onClick={onNewPeriod} />}</div>}</section>;
}

function AdminShortcut({ icon, title, text, onClick }: { icon: IconName; title: string; text: string; onClick: () => void }) {
  return <button onClick={onClick} className="flex w-full items-center gap-3 rounded-xl bg-[#f8faf7] p-3 text-left transition hover:bg-[#f0f5ed]"><span className="grid h-8 w-8 place-items-center rounded-lg bg-white text-[#68845d]"><Icon name={icon} size={15} /></span><span className="min-w-0 flex-1"><span className="block text-[10px] font-semibold text-[#506254]">{title}</span><span className="mt-1 block text-[9px] text-[#98a39b]">{text}</span></span><Icon name="chevron" size={14} className="text-[#a0aaa3]" /></button>;
}

function DialogLayer({ dialog, busy, availableBalance, types, topupPayment, pendingJoinPeriod, joinError, onClose, onJoin, onCancel, onTopup, onWithdraw, onCreateType, onCreatePeriod, onOpenTopup, onReconcileTopup, onReturnToJoin }: { dialog: Exclude<Dialog, null>; busy: boolean; availableBalance: number; types: TypeOption[]; topupPayment: TopupPayment | null; pendingJoinPeriod: Period | null; joinError: string; onClose: () => void; onJoin: (period: Period) => void; onCancel: (membership: Membership) => void; onTopup: (event: FormEvent<HTMLFormElement>) => void; onWithdraw: (event: FormEvent<HTMLFormElement>) => void; onCreateType: (event: FormEvent<HTMLFormElement>) => void; onCreatePeriod: (event: FormEvent<HTMLFormElement>) => void; onOpenTopup: () => void; onReconcileTopup: () => void; onReturnToJoin: () => void }) {
  const dialogRef = useRef<HTMLElement>(null);
  const closeRef = useRef(onClose);
  const busyRef = useRef(busy);
  useEffect(() => { closeRef.current = onClose; }, [onClose]);
  useEffect(() => { busyRef.current = busy; }, [busy]);
  useEffect(() => {
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const focusable = dialogRef.current?.querySelector<HTMLElement>('button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), a[href]');
    (focusable ?? dialogRef.current)?.focus();
    function handleEscape(event: KeyboardEvent) {
      if (event.key === "Escape" && !busyRef.current) closeRef.current();
    }
    document.addEventListener("keydown", handleEscape);
    return () => { document.removeEventListener("keydown", handleEscape); previousFocus?.focus(); };
  }, []);
  let title = "";
  let subtitle = "";
  if (dialog.kind === "join") { title = "Konfirmasi ikut arisan"; subtitle = "Periksa kembali detail sebelum mengunci iuran."; }
  if (dialog.kind === "cancel") { title = "Batalkan kepesertaan?"; subtitle = "Dana iuran akan dikembalikan ke saldo tersedia."; }
  if (dialog.kind === "topup") { title = "Top up saldo"; subtitle = "Pilih nominal. Saldo baru masuk setelah provider mengonfirmasi pembayaran."; }
  if (dialog.kind === "withdraw") { title = "Ajukan withdrawal"; subtitle = "Hanya saldo tersedia yang dapat ditarik."; }
  if (dialog.kind === "create-type") { title = "Jenis arisan baru"; subtitle = "Tentukan iuran dan batas peserta yang transparan."; }
  if (dialog.kind === "create-period") { title = "Buat periode"; subtitle = "Jadwal menggunakan zona waktu perangkat; deadline H-2 dihitung server Asia/Jakarta."; }
  return <div className="fixed inset-0 z-50 flex items-end justify-center bg-[#12271f]/45 p-0 backdrop-blur-[3px] sm:items-center sm:p-5" onMouseDown={(event) => { if (event.target === event.currentTarget && !busy) onClose(); }}><section ref={dialogRef} tabIndex={-1} onKeyDown={(event) => { if (event.key !== "Tab") return; const elements = dialogRef.current?.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), a[href]'); if (!elements?.length) return; const first = elements[0]; const last = elements[elements.length - 1]; if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); } else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); } }} role="dialog" aria-modal="true" aria-labelledby="dialog-title" aria-describedby="dialog-description" className="max-h-[92vh] w-full max-w-[490px] overflow-y-auto rounded-t-[26px] border border-white/50 bg-white p-5 shadow-[0_25px_90px_rgba(15,40,28,.22)] outline-none sm:rounded-[26px] sm:p-6"><div className="mx-auto mb-4 h-1 w-10 rounded-full bg-[#dfe6de] sm:hidden" /><div className="flex items-start justify-between gap-4"><div><h2 id="dialog-title" className="text-[18px] font-semibold tracking-[-.03em] text-[#21382b]">{title}</h2><p id="dialog-description" className="mt-1 text-[10px] leading-5 text-[#8b978f]">{subtitle}</p></div><button onClick={onClose} disabled={busy} aria-label="Tutup dialog" className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-[#f4f6f3] text-[#78867c]"><Icon name="close" size={16} /></button></div>
    {dialog.kind === "join" && <div className="mt-5"><div className="rounded-[17px] bg-[#f6f8f4] p-4"><div className="flex justify-between text-[10px]"><span className="text-[#859188]">Arisan</span><strong className="font-semibold text-[#3b5142]">{dialog.period.name}</strong></div><div className="mt-3 flex justify-between text-[10px]"><span className="text-[#859188]">Iuran terkunci</span><strong className="font-semibold text-[#3b5142]">{formatIDR(dialog.period.contributionAmount)}</strong></div><div className="mt-3 flex justify-between text-[10px]"><span className="text-[#859188]">Pemilihan pemenang</span><strong className="font-semibold text-[#3b5142]">{formatDate(dialog.period.drawingAt)}</strong></div><div className="mt-3 flex justify-between text-[10px]"><span className="text-[#859188]">Batas pembatalan</span><strong className="font-semibold text-[#3b5142]">{formatDateTime(dialog.period.cancellationDeadlineAt)} WIB</strong></div><div className="mt-4 border-t border-[#e7ece5] pt-3"><div className="flex justify-between text-[10px]"><span className="text-[#859188]">Saldo tersedia saat ini</span><strong className="font-semibold text-[#3b5142]">{formatIDR(availableBalance)}</strong></div><div className="mt-2 flex justify-between text-[10px]"><span className="text-[#859188]">Perkiraan setelah join</span><strong className="font-semibold text-[#3b5142]">{formatIDR(Math.max(0, availableBalance - dialog.period.contributionAmount))}</strong></div></div></div><div className="mt-3 flex gap-2 rounded-xl border border-[#e8eee5] bg-[#f9fbf7] p-3 text-[9px] leading-4 text-[#718170]"><Icon name="lock" size={15} className="mt-0.5 shrink-0 text-[#7f9a69]" />Dana iuran akan dipindahkan ke saldo terkunci dan hanya dapat dicairkan melalui pembatalan yang memenuhi batas waktu atau settlement periode.</div>{joinError && <div role="alert" className="mt-3 rounded-xl border border-[#f0d8d3] bg-[#fff6f3] p-3 text-[11px] leading-5 text-[#994d42]"><p>{joinError}</p><p className="mt-1">Periode {dialog.period.name} tetap tersimpan. Isi saldo, lalu kembali untuk melanjutkan.</p><button type="button" onClick={onOpenTopup} className="mt-2 rounded-lg bg-[#174e40] px-3 py-2 text-[10px] font-semibold text-white">Top up saldo</button></div>}<DialogButtons busy={busy} primary="Ikut arisan" onCancel={onClose} onConfirm={() => onJoin(dialog.period)} /></div>}
    {dialog.kind === "cancel" && <div className="mt-5"><div className="rounded-[17px] bg-[#f7f9f6] p-4"><p className="text-[11px] font-semibold text-[#385040]">{dialog.membership.name} · {dialog.membership.periodCode}</p><p className="mt-3 text-[22px] font-semibold tracking-[-.035em] text-[#33543b]">{formatIDR(dialog.membership.contributionAmount)}</p><p className="mt-1 text-[10px] text-[#8d9990]">Akan dikembalikan ke saldo tersedia.</p><div className="mt-4 flex items-center gap-2 rounded-xl bg-white px-3 py-3 text-[10px] text-[#708075]"><Icon name="clock" size={15} className="text-[#82976a]" />Batas pembatalan: <strong className="font-semibold text-[#4e6254]">{formatDateTime(dialog.membership.cancellationDeadlineAt)} WIB</strong></div></div><DialogButtons busy={busy} primary="Ya, batalkan" onCancel={onClose} onConfirm={() => onCancel(dialog.membership)} /></div>}
    {dialog.kind === "topup" && (topupPayment ? <div className="mt-5"><div className="rounded-2xl bg-[#f5f8f2] p-4"><p className="text-[10px] text-[#849188]">Nominal top up</p><p className="mt-1 text-xl font-semibold text-[#294d38]">{formatIDR(topupPayment.amount)}</p><p className="mt-3 text-[11px] font-semibold text-[#405747]">Status: {topupPayment.status === "SUCCESS" ? "Berhasil" : topupPayment.status === "PROCESSING" ? "Menunggu pembayaran" : topupPayment.status === "EXPIRED" ? "Kedaluwarsa" : topupPayment.status === "FAILED" ? "Gagal" : "Menunggu instruksi pembayaran"}</p><p className="mt-1 text-[10px] text-[#839087]">Batas pembayaran: {formatDateTime(topupPayment.expiresAt)} WIB. Saldo bertambah setelah provider mengonfirmasi pembayaran.</p></div>{topupPayment.checkoutUrl ? <a href={topupPayment.checkoutUrl} target="_blank" rel="noopener noreferrer" className="mt-3 flex h-11 items-center justify-center rounded-xl bg-[#174e40] text-xs font-semibold text-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#174e40]">Lanjutkan pembayaran<span className="sr-only"> (membuka tab baru)</span></a> : <p className="mt-3 rounded-xl bg-[#fff7e8] p-3 text-[10px] leading-5 text-[#876f40]">Tautan pembayaran belum tersedia. Periksa status lagi atau coba buat top up baru setelah provider pulih.</p>}<button type="button" disabled={busy || ["SUCCESS", "FAILED", "EXPIRED"].includes(topupPayment.status)} onClick={onReconcileTopup} className="mt-2 h-11 w-full rounded-xl border border-[#e2e9e1] bg-white text-xs font-semibold text-[#45634d] disabled:opacity-50">{busy ? "Memeriksa…" : "Periksa status pembayaran"}</button>{pendingJoinPeriod && <button type="button" onClick={onReturnToJoin} className="mt-2 h-11 w-full rounded-xl border border-[#e2e9e1] text-xs font-semibold text-[#748178]">Kembali ke {pendingJoinPeriod.name}</button>}<button type="button" onClick={onClose} className="mt-2 h-10 w-full text-xs font-semibold text-[#748178]">Tutup</button></div> : <form onSubmit={onTopup} className="mt-5"><label className="block text-[10px] font-semibold text-[#506053]">Nominal top up<input name="amount" type="number" min="10000" max="50000000" step="1000" required defaultValue="50000" className="mt-2 h-12 w-full rounded-xl border border-[#e3e9e2] px-3 text-sm outline-none focus:border-[#719476]" /></label><div className="mt-3 grid grid-cols-3 gap-2">{[10000,20000,50000,100000,250000,500000].map((value) => <button key={value} type="button" aria-label={`Pilih nominal ${formatIDR(value)}`} onClick={(event) => { const input = event.currentTarget.form?.elements.namedItem("amount") as HTMLInputElement | null; if (input) input.value = String(value); }} className="rounded-lg border border-[#e8ede7] bg-[#fafbf9] py-2 text-[9px] font-semibold text-[#708075] hover:border-[#bccfba]">{formatIDR(value)}</button>)}</div><p className="mt-3 rounded-xl bg-[#f8f5ea] px-3 py-2.5 text-[9px] leading-4 text-[#897a56]">Saldo baru masuk setelah pembayaran diverifikasi. Tautan pembayaran dan status dapat dilanjutkan dari jendela ini.</p><div className="mt-4 flex gap-2"><button type="button" onClick={onClose} className="h-11 flex-1 rounded-xl border border-[#e7ece7] text-xs font-semibold text-[#748178]">Batal</button><button disabled={busy} className="h-11 flex-1 rounded-xl bg-[#174e40] text-xs font-semibold text-white disabled:opacity-50">{busy ? "Memproses…" : "Top up"}</button></div></form>)}
    {dialog.kind === "withdraw" && <form onSubmit={onWithdraw} className="mt-5 space-y-3"><div className="rounded-xl bg-[#f4f7f2] px-3.5 py-3 text-[10px] text-[#738075]">Tersedia untuk ditarik: <strong className="text-[#405a43]">{formatIDR(availableBalance)}</strong></div><label className="block text-[10px] font-semibold text-[#506053]">Nominal<input name="amount" type="number" min="10000" max="50000000" step="1000" required className="mt-1.5 h-11 w-full rounded-xl border border-[#e3e9e2] px-3 text-xs outline-none focus:border-[#719476]" placeholder="Minimal Rp10.000" /></label><label className="block text-[10px] font-semibold text-[#506053]">Nama bank<input name="bankName" required maxLength={100} className="mt-1.5 h-11 w-full rounded-xl border border-[#e3e9e2] px-3 text-xs outline-none focus:border-[#719476]" placeholder="Contoh: Bank BCA" /></label><label className="block text-[10px] font-semibold text-[#506053]">Nama pemilik rekening<input name="accountName" required maxLength={120} className="mt-1.5 h-11 w-full rounded-xl border border-[#e3e9e2] px-3 text-xs outline-none focus:border-[#719476]" /></label><label className="block text-[10px] font-semibold text-[#506053]">Nomor rekening<input name="accountNumber" required inputMode="numeric" maxLength={32} className="mt-1.5 h-11 w-full rounded-xl border border-[#e3e9e2] px-3 text-xs outline-none focus:border-[#719476]" /></label><div className="flex gap-2 pt-1"><button type="button" onClick={onClose} className="h-11 flex-1 rounded-xl border border-[#e7ece7] text-xs font-semibold text-[#748178]">Batal</button><button disabled={busy} className="h-11 flex-1 rounded-xl bg-[#174e40] text-xs font-semibold text-white disabled:opacity-50">{busy ? "Memproses…" : "Ajukan withdrawal"}</button></div></form>}
    {dialog.kind === "create-type" && <form onSubmit={onCreateType} className="mt-5 space-y-3"><label className="block text-[10px] font-semibold text-[#506053]">Nama jenis<input name="name" required minLength={3} maxLength={120} className="mt-1.5 h-11 w-full rounded-xl border border-[#e3e9e2] px-3 text-xs outline-none focus:border-[#719476]" placeholder="Arisan Rp25.000" /></label><label className="block text-[10px] font-semibold text-[#506053]">Deskripsi<textarea name="description" maxLength={2000} rows={2} className="mt-1.5 w-full rounded-xl border border-[#e3e9e2] px-3 py-2 text-xs outline-none focus:border-[#719476]" placeholder="Informasi yang jelas bagi peserta" /></label><div className="grid grid-cols-2 gap-3"><label className="text-[10px] font-semibold text-[#506053]">Iuran (Rp)<input name="amount" type="number" min="1" required className="mt-1.5 h-11 w-full rounded-xl border border-[#e3e9e2] px-3 text-xs outline-none focus:border-[#719476]" /></label><label className="text-[10px] font-semibold text-[#506053]">Peserta maks.<input name="maximum" type="number" min="2" max="500" required defaultValue="10" className="mt-1.5 h-11 w-full rounded-xl border border-[#e3e9e2] px-3 text-xs outline-none focus:border-[#719476]" /></label><label className="text-[10px] font-semibold text-[#506053]">Peserta min.<input name="minimum" type="number" min="2" max="500" required defaultValue="2" className="mt-1.5 h-11 w-full rounded-xl border border-[#e3e9e2] px-3 text-xs outline-none focus:border-[#719476]" /></label><label className="text-[10px] font-semibold text-[#506053]">Batas batal (hari)<input name="days" type="number" min="1" max="30" required defaultValue="2" className="mt-1.5 h-11 w-full rounded-xl border border-[#e3e9e2] px-3 text-xs outline-none focus:border-[#719476]" /></label></div><div className="flex gap-2 pt-1"><button type="button" onClick={onClose} className="h-11 flex-1 rounded-xl border border-[#e7ece7] text-xs font-semibold text-[#748178]">Batal</button><button disabled={busy} className="h-11 flex-1 rounded-xl bg-[#174e40] text-xs font-semibold text-white disabled:opacity-50">{busy ? "Menyimpan…" : "Simpan jenis"}</button></div></form>}
    {dialog.kind === "create-period" && <form onSubmit={onCreatePeriod} className="mt-5 space-y-3">{types.filter((type) => type.active).length === 0 ? <p className="rounded-xl bg-[#fff7e8] p-3 text-xs text-[#876f40]">Buat jenis arisan terlebih dahulu.</p> : <><label className="block text-[10px] font-semibold text-[#506053]">Jenis arisan<select name="typeId" required className="mt-1.5 h-11 w-full rounded-xl border border-[#e3e9e2] bg-white px-3 text-xs outline-none focus:border-[#719476]">{types.filter((type) => type.active).map((type) => <option key={type.id} value={type.id}>{type.name} · {formatIDR(type.contributionAmount)}</option>)}</select></label><label className="block text-[10px] font-semibold text-[#506053]">Kode periode<input name="code" required minLength={5} maxLength={64} className="mt-1.5 h-11 w-full rounded-xl border border-[#e3e9e2] px-3 text-xs uppercase outline-none focus:border-[#719476]" placeholder="AR25K-2026-001" /></label><div className="grid gap-3 sm:grid-cols-2">{[["starts","Pendaftaran mulai"],["ends","Pendaftaran berakhir"],["drawing","Waktu drawing"]].map(([name,label]) => <label key={name} className="block text-[10px] font-semibold text-[#506053]">{label}<input name={name} type="datetime-local" required className="mt-1.5 h-11 w-full rounded-xl border border-[#e3e9e2] px-2 text-[10px] outline-none focus:border-[#719476]" /></label>)}</div><p className="rounded-xl bg-[#f8f5ea] px-3 py-2.5 text-[9px] leading-4 text-[#897a56]">Pastikan waktu pendaftaran berakhir sebelum deadline H-2. Server menghitung deadline pada akhir hari Asia/Jakarta.</p></>}<div className="flex gap-2 pt-1"><button type="button" onClick={onClose} className="h-11 flex-1 rounded-xl border border-[#e7ece7] text-xs font-semibold text-[#748178]">Batal</button><button disabled={busy || !types.some((type) => type.active)} className="h-11 flex-1 rounded-xl bg-[#174e40] text-xs font-semibold text-white disabled:opacity-50">{busy ? "Membuat…" : "Buka periode"}</button></div></form>}
  </section></div>;
}

function DialogButtons({ busy, primary, onCancel, onConfirm }: { busy: boolean; primary: string; onCancel: () => void; onConfirm: () => void }) {
  return <div className="mt-4 flex gap-2"><button disabled={busy} onClick={onCancel} className="h-11 flex-1 rounded-xl border border-[#e6ebe5] bg-white text-xs font-semibold text-[#77847b]">Kembali</button><button disabled={busy} onClick={onConfirm} className="flex h-11 flex-1 items-center justify-center gap-2 rounded-xl bg-[#174e40] text-xs font-semibold text-white transition hover:bg-[#103c31] disabled:opacity-50">{busy ? <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-white/50 border-t-white" /> : null}{busy ? "Memproses…" : primary}</button></div>;
}

function InfoTile({ label, value, icon }: { label: string; value: string; icon: IconName }) {
  return <div className="rounded-xl bg-[#f8faf7] px-3 py-2.5"><div className="flex items-center gap-1.5 text-[9px] text-[#9ba59d]"><Icon name={icon} size={12} />{label}</div><p className="mt-1.5 text-[10px] font-semibold text-[#54695b]">{value} WIB</p></div>;
}

function StatusBadge({ status }: { status: string }) {
  const normalized = status.toUpperCase();
  const config = normalized === "OPEN" || normalized === "ACTIVE" ? ["bg-[#e8f3e4] text-[#548059]", normalized === "OPEN" ? "Dibuka" : "Aktif"] : normalized === "FULL" ? ["bg-[#f4f0e3] text-[#9b8046]", "Penuh"] : normalized === "LOCKED" ? ["bg-[#f2ece1] text-[#94794a]", "Terkunci"] : normalized === "DRAWING" || normalized === "PAYOUT_PROCESSING" ? ["bg-[#eaf0f5] text-[#5c7e91]", "Drawing"] : normalized === "WINNER" ? ["bg-[#f8eed8] text-[#a37b2e]", "Pemenang"] : normalized === "COMPLETED" || normalized === "SUCCESS" ? ["bg-[#e8f3e4] text-[#548059]", "Selesai"] : normalized === "CANCELLED" || normalized === "FAILED" ? ["bg-[#f7eae7] text-[#a76657]", "Dibatalkan"] : ["bg-[#f0f2ef] text-[#7a867d]", normalized.toLowerCase()];
  return <span className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[9px] font-semibold ${config[0]}`}><span className="h-1.5 w-1.5 rounded-full bg-current opacity-70" />{config[1]}</span>;
}

function EmptyCard({ icon, title, text, action, onClick }: { icon: IconName; title: string; text: string; action?: string; onClick?: () => void }) {
  return <div className="flex flex-col items-center rounded-[20px] border border-dashed border-[#dfe7de] bg-white/70 px-5 py-9 text-center"><span className="grid h-11 w-11 place-items-center rounded-2xl bg-[#edf3e8] text-[#769268]"><Icon name={icon} size={19} /></span><h3 className="mt-3 text-xs font-semibold text-[#526357]">{title}</h3><p className="mt-1 max-w-[260px] text-[10px] leading-5 text-[#929e95]">{text}</p>{action && onClick && <button onClick={onClick} className="mt-4 rounded-xl bg-[#174e40] px-4 py-2.5 text-[10px] font-semibold text-white">{action}</button>}</div>;
}

function Notice({ message, onDismiss }: { message: string; onDismiss: () => void }) {
  return <div className="mb-4 flex items-center justify-between gap-3 rounded-xl border border-[#f0dfb9] bg-[#fff9ed] px-4 py-3 text-xs text-[#856c3e]"><span className="flex items-center gap-2"><Icon name="info" size={16} />{message}</span><button onClick={onDismiss} aria-label="Tutup" className="text-[#a18c61]"><Icon name="close" size={15} /></button></div>;
}

function LoadingState() {
  return <div className="animate-pulse-soft"><div className="mb-7 h-7 w-44 rounded-lg bg-[#e5ebe4]" /><div className="h-64 rounded-[28px] bg-[#e5ebe4]" /><div className="mt-6 grid gap-4 md:grid-cols-2"><div className="h-56 rounded-[22px] bg-[#e8ede7]" /><div className="h-56 rounded-[22px] bg-[#e8ede7]" /></div></div>;
}

function GuestLanding({ periods, error, onJoin, onRegister }: { periods: Period[]; error: string; onJoin: (period: Period) => void; onRegister: () => void }) {
  return <div className="animate-fade-up"><section className="relative mt-3 overflow-hidden rounded-[30px] bg-[#143e33] px-6 py-12 text-white sm:px-10 sm:py-16 lg:px-16 lg:py-[76px]"><div className="absolute -right-16 -top-24 h-[380px] w-[380px] rounded-full border border-white/[.09]" /><div className="absolute -right-1 -top-12 h-[265px] w-[265px] rounded-full border border-white/[.08]" /><div className="absolute -bottom-32 left-[40%] h-64 w-64 rounded-full bg-[#c1e599]/10 blur-3xl" /><div className="relative z-10 max-w-[690px]"><span className="inline-flex items-center gap-2 rounded-full border border-white/15 bg-white/[.06] px-3 py-2 text-[10px] font-semibold text-[#d4edb3]"><Icon name="shield" size={14} /> Arisan digital, lebih transparan</span><h1 className="mt-7 max-w-[650px] text-[42px] font-semibold leading-[1.04] tracking-[-.055em] sm:text-[60px] lg:text-[70px]">Giliran baik<br /><span className="text-[#c9e89f]">dimulai bersama.</span></h1><p className="mt-5 max-w-[490px] text-[13px] leading-6 text-white/65 sm:text-[15px] sm:leading-7">Ikuti arisan dengan saldo terpisah, batas pembatalan yang jelas, dan proses drawing yang tercatat.</p><div className="mt-7 flex flex-wrap gap-3"><Link href="/register" className="inline-flex items-center gap-2 rounded-xl bg-[#c9ec96] px-5 py-3.5 text-xs font-bold text-[#244731] transition hover:bg-[#d8f2b4]">Mulai bergabung <Icon name="arrowRight" size={16} /></Link><Link href="/login" className="inline-flex items-center rounded-xl border border-white/15 bg-white/[.06] px-5 py-3.5 text-xs font-semibold text-white/90 hover:bg-white/10">Masuk ke akun</Link></div></div><div className="relative z-10 mt-11 grid max-w-[580px] grid-cols-3 gap-2.5 sm:mt-14"><GuestStat label="Saldo tercatat" value="Terpisah" /><GuestStat label="Drawing" value="CSPRNG" /><GuestStat label="Riwayat dana" value="Transparan" /></div></section><div className="mt-8 grid gap-7 lg:grid-cols-[1.2fr_.8fr]"><section><div className="mb-4"><p className="text-[10px] font-bold uppercase tracking-[.15em] text-[#94a092]">Temukan periode</p><h2 className="mt-1 text-[21px] font-semibold tracking-[-.03em] text-[#273d30]">Arisan yang sedang dibuka</h2></div>{error && <Notice message={error} onDismiss={() => undefined} />}{periods.filter((period) => period.status === "OPEN").length ? <div className="grid gap-3 sm:grid-cols-2">{periods.filter((period) => period.status === "OPEN").slice(0, 4).map((period) => <PeriodCard key={period.id} period={period} joined={false} onJoin={() => onJoin(period)} />)}</div> : <EmptyCard icon="users" title="Periode baru segera hadir" text="Buat akun untuk menjelajahi arisan yang dibuka admin." action="Buat akun gratis" onClick={onRegister} />}</section><section className="rounded-[23px] border border-[#e6ece5] bg-white p-6"><p className="text-[10px] font-bold uppercase tracking-[.15em] text-[#91a08f]">Cara kerja</p><h2 className="mt-2 text-[19px] font-semibold tracking-[-.03em] text-[#294334]">Jelas di setiap langkah.</h2><div className="mt-5 space-y-4">{[["01","Pilih periode","Cek nominal iuran, kuota, dan jadwal drawing."],["02","Iuran dikunci","Dana berpindah dari available ke locked."],["03","Drawing tercatat","Pemenang dipilih dengan random yang aman."]].map(([number,title,text]) => <div key={number} className="flex gap-3"><span className="grid h-8 w-8 shrink-0 place-items-center rounded-xl bg-[#eff5e9] text-[10px] font-bold text-[#69875b]">{number}</span><div><p className="text-xs font-semibold text-[#4c5d50]">{title}</p><p className="mt-1 text-[10px] leading-4 text-[#929e95]">{text}</p></div></div>)}</div><div className="mt-5 rounded-xl bg-[#f8f5ea] p-3 text-[9px] leading-4 text-[#8a7a55]">Layanan ini masih memerlukan peninjauan regulasi sebelum menerima dana nyata.</div></section></div></div>;
}

function GuestStat({ label, value }: { label: string; value: string }) {
  return <div className="rounded-2xl border border-white/10 bg-white/[.06] px-3 py-3.5 sm:px-4"><p className="text-[9px] text-white/50">{label}</p><p className="mt-1.5 text-[13px] font-semibold text-white sm:text-[15px]">{value}</p></div>;
}

function subtitleFor(tab: Tab): string {
  if (tab === "explore") return "Periode dan iuran yang tersedia untuk diikuti.";
  if (tab === "mine") return "Kepesertaan aktif dan riwayat arisan kamu.";
  if (tab === "wallet") return "Rincian saldo dan pergerakan dana yang tercatat.";
  if (tab === "notifications") return "Informasi penting mengenai aktivitas akunmu.";
  return "Pantau operasional dan konfigurasi arisan.";
}
