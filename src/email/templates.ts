import type { EmailMessage } from './sender.js'

function escapeHtml(value: string) {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

function actionEmail(input: { actionLabel: string; displayName: string; expires: string; introduction: string; subject: string; url: string }): EmailMessage {
  const displayName = escapeHtml(input.displayName)
  const url = escapeHtml(input.url)
  return {
    subject: input.subject,
    text: `Chào ${input.displayName},\n\n${input.introduction}\n\n${input.actionLabel}: ${input.url}\n\nLiên kết có hiệu lực ${input.expires}. Nếu bạn không thực hiện yêu cầu này, hãy bỏ qua email.`,
    html: `<p>Chào ${displayName},</p><p>${escapeHtml(input.introduction)}</p><p><a href="${url}">${escapeHtml(input.actionLabel)}</a></p><p>Liên kết có hiệu lực ${escapeHtml(input.expires)}. Nếu bạn không thực hiện yêu cầu này, hãy bỏ qua email.</p>`,
    to: '',
  }
}

export function passwordResetEmail(displayName: string, to: string, url: string): EmailMessage {
  return {
    ...actionEmail({
      actionLabel: 'Đặt lại mật khẩu DayTrail',
      displayName,
      expires: 'trong 30 phút',
      introduction: 'DayTrail nhận được yêu cầu đặt lại mật khẩu cho tài khoản của bạn.',
      subject: 'Đặt lại mật khẩu DayTrail',
      url,
    }),
    to,
  }
}

export function verificationEmail(displayName: string, to: string, url: string): EmailMessage {
  return {
    ...actionEmail({
      actionLabel: 'Xác minh email DayTrail',
      displayName,
      expires: 'trong 24 giờ',
      introduction: 'Hãy xác minh địa chỉ email để hoàn tất thông tin tài khoản DayTrail.',
      subject: 'Xác minh email DayTrail',
      url,
    }),
    to,
  }
}

export function passwordChangedEmail(displayName: string, to: string): EmailMessage {
  return {
    to,
    subject: 'Mật khẩu DayTrail đã thay đổi',
    text: `Chào ${displayName},\n\nMật khẩu DayTrail của bạn vừa được thay đổi. Tất cả phiên đăng nhập cũ đã bị thu hồi. Nếu bạn không thực hiện thay đổi này, hãy liên hệ người quản trị dịch vụ.`,
    html: `<p>Chào ${escapeHtml(displayName)},</p><p>Mật khẩu DayTrail của bạn vừa được thay đổi. Tất cả phiên đăng nhập cũ đã bị thu hồi.</p><p>Nếu bạn không thực hiện thay đổi này, hãy liên hệ người quản trị dịch vụ.</p>`,
  }
}
