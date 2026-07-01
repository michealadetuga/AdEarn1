import nodemailer from "nodemailer";

type MailTemplate = {
  subject: string;
  html: string;
  text: string;
};

function escapeHtml(value: string) {
  return value.replace(/[&<>"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[char] ?? char));
}

function baseHtml(title: string, body: string) {
  return `
  <div style="margin:0;background:#f7f7f7;padding:24px;font-family:Arial,sans-serif;color:#0A0A0A">
    <div style="max-width:560px;margin:0 auto;background:#fff;border-radius:18px;overflow:hidden;border:1px solid #eee">
      <div style="background:#0A0A0A;color:#F5C518;padding:22px 24px;font-size:26px;font-weight:800">AdEarn</div>
      <div style="padding:24px">
        <h1 style="font-size:22px;line-height:1.25;margin:0 0 16px">${escapeHtml(title)}</h1>
        ${body}
        <p style="margin-top:28px;font-size:12px;color:#777">You are receiving this because you have an AdEarn account. Address placeholder: Lagos, Nigeria.</p>
      </div>
    </div>
  </div>`;
}

export function createTransporter() {
  if (!process.env.GMAIL_USER || !process.env.GMAIL_PASS) {
    return null;
  }

  return nodemailer.createTransport({
    service: "gmail",
    auth: {
      user: process.env.GMAIL_USER,
      pass: process.env.GMAIL_PASS,
    },
  });
}

export const templates = {
  welcome(name: string, referralCode: string): MailTemplate {
    const safeName = escapeHtml(name);
    const safeCode = escapeHtml(referralCode);
    const dashboardUrl = `${process.env.FRONTEND_URL ?? "http://localhost:5173"}/dashboard`;
    return {
      subject: "Welcome to AdEarn - Start Earning Now",
      html: baseHtml(
        `Welcome to AdEarn, ${safeName}`,
        `<p>Watch short ads, earn points, and withdraw in Naira. Your referral code is <strong>${safeCode}</strong>.</p><p><a href="${dashboardUrl}" style="display:inline-block;background:#F5C518;color:#0A0A0A;padding:13px 18px;border-radius:12px;font-weight:700;text-decoration:none">Open Dashboard</a></p>`
      ),
      text: `Welcome to AdEarn, ${name}\n\nWatch short ads, earn points, and withdraw in Naira. Referral code: ${referralCode}`,
    };
  },
  withdrawalRequested(name: string, amount: number, bank: string, account: string): MailTemplate {
    return {
      subject: "Withdrawal Request Received",
      html: baseHtml("Withdrawal request received", `<p>Hi ${escapeHtml(name)}, we received your request for NGN ${amount.toLocaleString()} to ${escapeHtml(bank)} (${escapeHtml(account)}). Processing usually takes 24-48 hours.</p>`),
      text: `Hi ${name}, your NGN ${amount} withdrawal to ${bank} (${account}) was received.`,
    };
  },
  withdrawalPaid(name: string, amount: number, bank: string): MailTemplate {
    return {
      subject: "Your AdEarn Payout Has Been Sent",
      html: baseHtml("Payout sent", `<p>Hi ${escapeHtml(name)}, your NGN ${amount.toLocaleString()} payout to ${escapeHtml(bank)} has been marked as paid.</p>`),
      text: `Hi ${name}, your NGN ${amount} payout to ${bank} has been marked as paid.`,
    };
  },
  withdrawalRejected(name: string, amount: number, reason: string): MailTemplate {
    return {
      subject: "AdEarn Withdrawal Update",
      html: baseHtml("Withdrawal update", `<p>Hi ${escapeHtml(name)}, your NGN ${amount.toLocaleString()} withdrawal was rejected.</p><p><strong>Reason:</strong> ${escapeHtml(reason)}</p><p>Your points have been refunded.</p>`),
      text: `Hi ${name}, your NGN ${amount} withdrawal was rejected. Reason: ${reason}. Your points have been refunded.`,
    };
  },
};

export async function sendMail(to: string | undefined, template: MailTemplate) {
  if (!to) return;
  const transporter = createTransporter();
  if (!transporter) return;

  await transporter.sendMail({
    from: `"AdEarn" <${process.env.GMAIL_USER}>`,
    to,
    subject: template.subject,
    html: template.html,
    text: template.text,
  });
}
