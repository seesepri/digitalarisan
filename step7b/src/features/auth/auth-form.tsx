"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { FormEvent, useState } from "react";
import { Icon } from "@/components/icon";
import { ApiClientError, apiFetch } from "@/lib/api-client";

type AuthMode = "login" | "register";

export function AuthForm({ mode }: { mode: AuthMode }) {
  const router = useRouter();
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [identifier, setIdentifier] = useState("");
  const [password, setPassword] = useState("");
  const [verificationPhone, setVerificationPhone] = useState("");
  const [verificationCode, setVerificationCode] = useState("");
  const [forgotPassword, setForgotPassword] = useState(false);
  const [resetPhone, setResetPhone] = useState("");
  const [resetRequested, setResetRequested] = useState(false);
  const [resetCode, setResetCode] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [resetComplete, setResetComplete] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const isRegister = mode === "register";

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    if (forgotPassword) {
      if (resetComplete) return;
      if (resetRequested && newPassword.length < 10) {
        setError("Password minimal 10 karakter.");
        return;
      }
      setBusy(true);
      try {
        if (!resetRequested) {
          const result = await apiFetch<{ requested: boolean }>("/api/v1/auth/password/forgot", {
            method: "POST",
            body: JSON.stringify({ phone: resetPhone }),
          });
          if (result.data.requested) setResetRequested(true);
        } else {
          await apiFetch("/api/v1/auth/password/reset", {
            method: "POST",
            body: JSON.stringify({ phone: resetPhone, code: resetCode, newPassword }),
          });
          setResetComplete(true);
          setResetCode("");
          setNewPassword("");
        }
      } catch (caught) {
        setError(caught instanceof ApiClientError ? caught.message : "Terjadi masalah. Silakan coba kembali.");
      } finally {
        setBusy(false);
      }
      return;
    }
    if ((verificationPhone && isRegister && password.length < 10) || (!verificationPhone && !isRegister && password.length < 1)) {
      setError(isRegister ? "Password minimal 10 karakter." : "Masukkan password Anda.");
      return;
    }
    setBusy(true);
    try {
      if (verificationPhone) {
        await apiFetch("/api/v1/auth/phone/verify", {
          method: "POST",
          body: JSON.stringify({ phone: verificationPhone, code: verificationCode, ...(isRegister ? { name, password } : {}) }),
        });
      } else {
        const result = isRegister
          ? await apiFetch<{ verificationRequired?: boolean; phone?: string }>("/api/v1/auth/register", {
              method: "POST",
              body: JSON.stringify({ phone }),
            })
          : await apiFetch<{ verificationRequired?: boolean; phone?: string }>("/api/v1/auth/login", {
              method: "POST",
              body: JSON.stringify({ identifier, password }),
            });
        if (result.data.verificationRequired) {
          setVerificationPhone(result.data.phone ?? phone);
          setVerificationCode("");
          return;
        }
      }
      router.replace("/");
      router.refresh();
    } catch (caught) {
      setError(caught instanceof ApiClientError ? caught.message : "Terjadi masalah. Silakan coba kembali.");
    } finally {
      setBusy(false);
    }
  }

  async function resendCode() {
    setError("");
    setBusy(true);
    try {
      if (isRegister) {
        await apiFetch("/api/v1/auth/register", { method: "POST", body: JSON.stringify({ phone: verificationPhone }) });
      } else {
        const result = await apiFetch<{ verificationRequired?: boolean }>("/api/v1/auth/login", { method: "POST", body: JSON.stringify({ identifier, password }) });
        if (!result.data.verificationRequired) {
          router.replace("/");
          router.refresh();
        }
      }
      setVerificationCode("");
    } catch (caught) {
      setError(caught instanceof ApiClientError ? caught.message : "Terjadi masalah. Silakan coba kembali.");
    } finally {
      setBusy(false);
    }
  }

  async function resendPasswordResetCode() {
    setError("");
    setBusy(true);
    try {
      await apiFetch("/api/v1/auth/password/forgot", {
        method: "POST",
        body: JSON.stringify({ phone: resetPhone }),
      });
      setResetCode("");
    } catch (caught) {
      setError(caught instanceof ApiClientError ? caught.message : "Terjadi masalah. Silakan coba kembali.");
    } finally {
      setBusy(false);
    }
  }

  function openPasswordReset() {
    setResetPhone(/^[+\d\s()-]*$/.test(identifier) ? identifier : "");
    setResetRequested(false);
    setResetComplete(false);
    setResetCode("");
    setNewPassword("");
    setError("");
    setForgotPassword(true);
  }

  return (
    <main className="min-h-screen bg-[#f4f7f3] px-4 py-5 sm:px-7 sm:py-8">
      <div className="mx-auto flex max-w-6xl items-center justify-between">
        <Link href="/" className="flex items-center gap-3 text-[18px] font-bold tracking-[-.04em] text-[#163e33]">
          <span className="grid h-10 w-10 place-items-center rounded-[14px] bg-[#d6efb5] text-[#174e40]"><Icon name="sparkles" size={21} /></span>
          seearisan<span className="text-[#99a99f]">.</span>
        </Link>
      </div>

      <div className="mx-auto mt-8 grid max-w-5xl overflow-hidden rounded-[30px] border border-[#e5ebe5] bg-white shadow-[0_22px_70px_rgba(24,54,41,.08)] md:mt-12 md:grid-cols-[.94fr_1.06fr]">
        <section className="relative hidden min-h-[620px] flex-col justify-between overflow-hidden bg-[#123b31] p-10 text-white md:flex lg:p-12">
          <div className="absolute -right-24 -top-20 h-80 w-80 rounded-full border border-white/10" />
          <div className="absolute -right-12 -top-8 h-56 w-56 rounded-full border border-white/10" />
          <div className="absolute -bottom-32 -left-24 h-80 w-80 rounded-full bg-[#a8d76f]/10 blur-2xl" />
          <div className="relative z-10">
            <p className="inline-flex items-center gap-2 rounded-full border border-white/15 bg-white/5 px-3 py-2 text-[11px] font-semibold uppercase tracking-[.16em] text-[#c9eaa1]"><Icon name="shield" size={15} /> Aman, jelas, tercatat</p>
            <h1 className="mt-12 max-w-sm text-[42px] font-semibold leading-[1.06] tracking-[-.05em] lg:text-[48px]">
              Giliranmu,
              <br />
              dengan tenang.
            </h1>
            <p className="mt-5 max-w-sm text-[15px] leading-7 text-white/65">Satu ruang untuk bergabung, memantau iuran terkunci, dan mengikuti proses arisan dengan transparan.</p>
          </div>
          <div className="relative z-10 rounded-[22px] border border-white/10 bg-white/[.06] p-5">
            <div className="flex items-center justify-between text-sm">
              <span className="text-white/60">Setiap pergerakan tercatat</span>
              <Icon name="arrowRight" size={17} className="text-[#c9eaa1]" />
            </div>
            <div className="mt-4 flex items-center gap-3">
              {["AR", "NA", "DI", "+7"].map((avatar, index) => (
                <span key={avatar} className={`grid h-9 w-9 place-items-center rounded-full border-2 border-[#123b31] text-[10px] font-bold ${index === 3 ? "bg-[#d4ebae] text-[#24543b]" : "bg-white/15 text-white"}`}>{avatar}</span>
              ))}
              <span className="ml-1 text-xs text-white/60">Teman ikut bertumbuh bersama</span>
            </div>
          </div>
        </section>

        <section className="relative px-6 py-8 sm:px-10 sm:py-12 lg:px-14">
          <Link href="/" aria-label="Tutup dan kembali ke beranda" title="Tutup" className="absolute right-5 top-5 z-10 grid h-9 w-9 place-items-center rounded-full border border-[#e5ebe5] bg-white text-[#53665a] transition hover:bg-[#f5f8f3] hover:text-[#174e40] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#174e40] sm:right-6 sm:top-6">
            <Icon name="close" size={17} />
          </Link>
          <div className="mb-8 inline-flex rounded-full bg-[#f2f6f1] p-1 text-xs font-semibold text-[#77847d]">
            <Link href="/login" className={`rounded-full px-4 py-2.5 transition ${!isRegister ? "bg-white text-[#183f33] shadow-sm" : "hover:text-[#183f33]"}`}>Masuk</Link>
            <Link href="/register" className={`rounded-full px-4 py-2.5 transition ${isRegister ? "bg-white text-[#183f33] shadow-sm" : "hover:text-[#183f33]"}`}>Daftar</Link>
          </div>
          <p className="text-[11px] font-bold uppercase tracking-[.17em] text-[#8f9a91]">{forgotPassword ? "Pemulihan akun" : isRegister ? "Mulai bersama" : "Selamat datang kembali"}</p>
          <h2 className="mt-2 text-[32px] font-semibold tracking-[-.045em] text-[#17241e]">{forgotPassword ? resetComplete ? "Password diperbarui" : "Reset password" : isRegister ? "Buat akunmu" : "Masuk ke akun"}</h2>
          <p className="mt-2 text-sm leading-6 text-[#7a877f]">{forgotPassword ? resetComplete ? "Silakan masuk menggunakan password baru." : resetRequested ? "Masukkan OTP SMS dan tentukan password baru." : "Masukkan nomor HP yang terdaftar untuk memulai pemulihan." : verificationPhone ? "Verifikasi nomor HP untuk melanjutkan dengan aman." : isRegister ? "Daftar dengan nomor HP dan verifikasi melalui SMS." : "Kelola arisan dan saldo dengan aman."}</p>

          {resetComplete ? (
            <div className="mt-8 rounded-xl border border-[#dcebd8] bg-[#f3f8ef] p-4 text-sm text-[#486b4b">Password berhasil direset. Semua sesi lama sudah dikeluarkan.</div>
          ) : (
            <form onSubmit={onSubmit} className="mt-8 space-y-4">
              {forgotPassword ? (
                resetRequested ? (
                  <>
                    <div className="rounded-xl bg-[#f3f7f0] px-4 py-3 text-xs leading-5 text-[#627466]">Jika nomor HP terdaftar dan terverifikasi, kode reset dikirim lewat SMS ke nomor berakhiran <strong className="font-semibold text-[#35533d]">{resetPhone.slice(-4)}</strong>.</div>
                    <label className="block text-xs font-semibold text-[#46554c]">Kode OTP
                      <input value={resetCode} onChange={(event) => setResetCode(event.target.value.replace(/\D/g, "").slice(0, 10))} required inputMode="numeric" autoComplete="one-time-code" minLength={4} maxLength={10} className="mt-2 h-12 w-full rounded-[13px] border border-[#e5ebe5] bg-white px-4 text-center text-lg tracking-[.35em] outline-none transition focus:border-[#4c826d] focus:ring-4 focus:ring-[#2c7353]/10" placeholder="••••••" />
                    </label>
                    <label className="block text-xs font-semibold text-[#46554c]">Password baru
                      <input value={newPassword} onChange={(event) => setNewPassword(event.target.value)} required minLength={10} maxLength={128} type={showPassword ? "text" : "password"} autoComplete="new-password" className="mt-2 h-12 w-full rounded-[13px] border border-[#e5ebe5] bg-white px-4 text-sm outline-none transition focus:border-[#4c826d] focus:ring-4 focus:ring-[#2c7353]/10" placeholder="Min. 10 karakter, huruf dan angka" />
                    </label>
                  </>
                ) : (
                  <label className="block text-xs font-semibold text-[#46554c]">Nomor HP terdaftar
                    <input value={resetPhone} onChange={(event) => setResetPhone(event.target.value)} required inputMode="tel" autoComplete="tel" maxLength={24} className="mt-2 h-12 w-full rounded-[13px] border border-[#e5ebe5] bg-white px-4 text-sm outline-none transition placeholder:text-[#a8b1aa] focus:border-[#4c826d] focus:ring-4 focus:ring-[#2c7353]/10" placeholder="08xx xxxx xxxx" />
                  </label>
                )
              ) : verificationPhone ? (
                <>
                  <div className="rounded-xl bg-[#f3f7f0] px-4 py-3 text-xs leading-5 text-[#627466]">Masukkan kode OTP yang dikirim melalui SMS ke nomor berakhiran <strong className="font-semibold text-[#35533d]">{verificationPhone.slice(-4)}</strong>. Kode berlaku selama 5 menit.</div>
                  <label className="block text-xs font-semibold text-[#46554c]">Kode OTP
                    <input value={verificationCode} onChange={(event) => setVerificationCode(event.target.value.replace(/\D/g, "").slice(0, 10))} required inputMode="numeric" autoComplete="one-time-code" minLength={4} maxLength={10} className="mt-2 h-12 w-full rounded-[13px] border border-[#e5ebe5] bg-white px-4 text-center text-lg tracking-[.35em] outline-none transition focus:border-[#4c826d] focus:ring-4 focus:ring-[#2c7353]/10" placeholder="••••••" />
                  </label>
                  {isRegister && <>
                    <label className="block text-xs font-semibold text-[#46554c]">Nama lengkap
                      <input value={name} onChange={(event) => setName(event.target.value)} required minLength={2} maxLength={120} autoComplete="name" className="mt-2 h-12 w-full rounded-[13px] border border-[#e5ebe5] bg-white px-4 text-sm outline-none transition focus:border-[#4c826d] focus:ring-4 focus:ring-[#2c7353]/10" placeholder="Nama sesuai identitas" />
                    </label>
                    <label className="block text-xs font-semibold text-[#46554c]">Password
                      <input value={password} onChange={(event) => setPassword(event.target.value)} required minLength={10} maxLength={128} type={showPassword ? "text" : "password"} autoComplete="new-password" className="mt-2 h-12 w-full rounded-[13px] border border-[#e5ebe5] bg-white px-4 text-sm outline-none transition focus:border-[#4c826d] focus:ring-4 focus:ring-[#2c7353]/10" placeholder="Min. 10 karakter, huruf dan angka" />
                    </label>
                  </>}
                  <button type="button" onClick={() => { setVerificationPhone(""); setVerificationCode(""); setError(""); }} className="text-xs font-medium text-[#718078] hover:text-[#174e40]">Ganti nomor atau kembali</button>
                </>
              ) : isRegister ? (
                <label className="block text-xs font-semibold text-[#46554c]">Nomor HP
                  <input value={phone} onChange={(event) => setPhone(event.target.value)} required inputMode="tel" autoComplete="tel" maxLength={24} className="mt-2 h-12 w-full rounded-[13px] border border-[#e5ebe5] bg-white px-4 text-sm outline-none transition placeholder:text-[#a8b1aa] focus:border-[#4c826d] focus:ring-4 focus:ring-[#2c7353]/10" placeholder="08xx xxxx xxxx" />
                </label>
              ) : (
                <>
                  <label className="block text-xs font-semibold text-[#46554c]">Email atau nomor HP
                    <input value={identifier} onChange={(event) => setIdentifier(event.target.value)} required autoComplete="username" className="mt-2 h-12 w-full rounded-[13px] border border-[#e5ebe5] bg-white px-4 text-sm outline-none transition placeholder:text-[#a8b1aa] focus:border-[#4c826d] focus:ring-4 focus:ring-[#2c7353]/10" placeholder="nama@email.com / 08xx" />
                  </label>
                  <label className="block text-xs font-semibold text-[#46554c]">Password
                    <span className="relative mt-2 block">
                      <input aria-label="Password" value={password} onChange={(event) => setPassword(event.target.value)} required minLength={1} maxLength={128} type={showPassword ? "text" : "password"} autoComplete="current-password" className="h-12 w-full rounded-[13px] border border-[#e5ebe5] bg-white px-4 pr-12 text-sm outline-none transition placeholder:text-[#a8b1aa] focus:border-[#4c826d] focus:ring-4 focus:ring-[#2c7353]/10" placeholder="Masukkan password" />
                      <button type="button" onClick={() => setShowPassword(!showPassword)} aria-label={showPassword ? "Sembunyikan password" : "Tampilkan password"} className="absolute right-3 top-1/2 -translate-y-1/2 rounded-lg p-1.5 text-[#8c9990] hover:bg-[#f1f5f1]"><Icon name="eye" size={17} /></button>
                    </span>
                  </label>
                </>
              )}
              {error && <p role="alert" className="rounded-xl border border-[#f2d7d3] bg-[#fff5f3] px-3.5 py-3 text-xs leading-5 text-[#a4463c]">{error}</p>}
              <button disabled={busy} className="mt-2 flex h-[50px] w-full items-center justify-center gap-2 rounded-[14px] bg-[#174e40] px-4 text-sm font-semibold text-white shadow-[0_8px_16px_rgba(23,78,64,.15)] transition hover:bg-[#103b30] disabled:cursor-wait disabled:opacity-60">
                {busy ? <span className="h-4 w-4 animate-spin rounded-full border-2 border-white/40 border-t-white" /> : null}
                {busy ? "Memproses…" : forgotPassword ? resetRequested ? "Simpan password baru" : "Kirim kode reset" : verificationPhone ? isRegister ? "Verifikasi & buat akun" : "Verifikasi & masuk" : isRegister ? "Kirim kode OTP" : "Masuk dengan aman"}
                {!busy && <Icon name="arrowRight" size={17} />}
              </button>
            </form>
          )}
          {!isRegister && !forgotPassword && !verificationPhone && <button type="button" onClick={openPasswordReset} className="mt-4 w-full text-right text-xs font-semibold text-[#477758] hover:text-[#174e40]">Lupa password?</button>}
          {forgotPassword && resetRequested && !resetComplete && <button type="button" disabled={busy} onClick={() => void resendPasswordResetCode()} className="mt-4 w-full text-center text-xs font-semibold text-[#477758] hover:text-[#174e40] disabled:opacity-50">Kirim ulang kode reset</button>}
          {forgotPassword && <button type="button" onClick={() => { setForgotPassword(false); setResetRequested(false); setResetComplete(false); setResetCode(""); setNewPassword(""); setError(""); }} className="mt-4 w-full text-center text-xs font-semibold text-[#718078] hover:text-[#174e40]">Kembali ke masuk</button>}
        </section>
      </div>
    </main>
  );
}
