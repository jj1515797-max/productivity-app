/** 생산 완료 Gmail 알림 — Google Apps Script 웹앱(doPost) 으로 신호 발송
 *
 * Apps Script 웹앱은 CORS 응답 헤더를 주지 않으므로 mode:'no-cors' 로 fire-and-forget.
 * (응답은 못 읽지만 발송은 됨 — 성공 여부는 메일 도착으로 확인)
 * Content-Type 을 text/plain 으로 보내 CORS preflight 도 회피.
 */
export interface NotifySettings {
  enabled?: boolean;
  emails?: string;   // 콤마 구분 — Apps Script(시간트리거)가 appMeta/notifySettings 에서 읽어 발송
  webAppUrl?: string;   // Apps Script 웹앱 배포 URL — 100% 시 앱이 이 주소로 직접 신호 발송(읽기 0)
  updatedAt?: string;
}
