import type { TranslationKeys } from './en';

export const tr: TranslationKeys = {
  // Auth
  auth: {
    invalidCredentials: 'Geçersiz e-posta veya şifre',
    emailAlreadyRegistered: 'Bu e-posta adresi zaten kayıtlı',
    userNotFound: 'Kullanıcı bulunamadı',
    invalidRefreshToken: 'Geçersiz yenileme tokeni',
    sessionNotFound: 'Oturum bulunamadı veya süresi dolmuş',
    invalidTokenType: 'Geçersiz token türü',
    invalidToken: 'Geçersiz veya süresi dolmuş token',
    missingAuthHeader: 'Eksik veya geçersiz yetkilendirme başlığı',
    logoutSuccess: 'Başarıyla çıkış yapıldı',
    noOrganization: 'Kullanıcının organizasyonu yok',
    invalidPassword: 'Geçersiz şifre',
    profileUpdated: 'Profil başarıyla güncellendi',
    passwordChanged: 'Şifre başarıyla değiştirildi',
    currentPasswordIncorrect: 'Mevcut şifre yanlış',
    newPasswordSameAsCurrent: 'Yeni şifre mevcut şifreden farklı olmalıdır',
    sessionTerminated: 'Oturum başarıyla sonlandırıldı',
    otherSessionsTerminated: 'Diğer tüm oturumlar sonlandırıldı',
    cannotTerminateCurrentSession: 'Mevcut oturumunuzu sonlandıramazsınız',
    passwordResetTokenSent: 'Bu e-posta adresine ait bir hesap varsa, şifre sıfırlama bağlantısı gönderildi',
    passwordResetTokenInvalid: 'Geçersiz veya süresi dolmuş şifre sıfırlama tokeni',
    passwordResetTokenExpired: 'Şifre sıfırlama tokeninin süresi dolmuş',
    passwordResetSuccess: 'Şifre başarıyla sıfırlandı',
    emailVerificationSent: 'Doğrulama e-postası gönderildi. Lütfen gelen kutunuzu kontrol edin.',
    emailAlreadyVerified: 'E-posta adresiniz zaten doğrulanmış.',
    emailVerificationInvalid: 'Geçersiz veya süresi dolmuş doğrulama tokeni.',
    emailVerified: 'E-posta adresiniz başarıyla doğrulandı.',
  },

  // Validation
  validation: {
    invalidRequest: 'Geçersiz istek verisi',
    invalidEmail: 'Geçersiz e-posta adresi',
    passwordMinLength: 'Şifre en az 8 karakter olmalıdır',
    passwordUppercase: 'Şifre en az bir büyük harf içermelidir',
    passwordLowercase: 'Şifre en az bir küçük harf içermelidir',
    passwordNumber: 'Şifre en az bir rakam içermelidir',
    nameMinLength: 'İsim en az 2 karakter olmalıdır',
    nameMaxLength: 'İsim en fazla 100 karakter olabilir',
    required: 'Bu alan zorunludur',
  },

  // Errors
  errors: {
    notFound: 'İstenen kaynak bulunamadı',
    internalError: 'Beklenmeyen bir hata oluştu',
    badRequest: 'Geçersiz istek',
    unauthorized: 'Yetkisiz erişim',
    forbidden: 'Erişim engellendi',
    conflict: 'Çakışma',
    tooManyRequests: 'Çok fazla istek',
    malformedJson: 'İstek gövdesinde hatalı JSON',
  },

  // Projects
  projects: {
    notFound: 'Proje bulunamadı',
    nameRequired: 'Proje adı zorunludur',
    created: 'Proje başarıyla oluşturuldu',
    updated: 'Proje başarıyla güncellendi',
    deleted: 'Proje başarıyla silindi',
    webhookRegenerated: 'Webhook anahtarı başarıyla yenilendi',
    settingsUpdated: 'Proje ayarları başarıyla güncellendi',
    invalidServer: 'Seçilen sunucu mevcut değil veya bu organizasyona ait değil',
    serverNotReady: 'Seçilen sunucu deployment için hazır değil',
  },

  // Organizations
  organizations: {
    notFound: 'Organizasyon bulunamadı',
    noAccess: 'Bu organizasyona erişim izniniz yok',
    updated: 'Organizasyon başarıyla güncellendi',
    slugTaken: 'Bu slug zaten kullanımda',
    userNotFound: 'Bu e-posta ile kullanıcı bulunamadı',
    alreadyMember: 'Kullanıcı zaten bu organizasyonun üyesi',
    memberNotFound: 'Üye bulunamadı',
    memberAdded: 'Üye başarıyla eklendi',
    memberRemoved: 'Üye başarıyla kaldırıldı',
    cannotChangeOwner: 'Organizasyon sahibinin rolü değiştirilemez',
    cannotRemoveOwner: 'Organizasyon sahibi kaldırılamaz',
    roleUpdated: 'Üye rolü başarıyla güncellendi',
    adminRequired: 'Bu işlemi yalnızca sahipler ve yöneticiler yapabilir',
    invitationSent: 'Davet başarıyla gönderildi',
    invitationNotFound: 'Davet bulunamadı veya süresi dolmuş',
    invitationRevoked: 'Davet başarıyla iptal edildi',
    invitationAlreadyAccepted: 'Bu davet zaten kabul edilmiş',
    invitationExpired: 'Bu davetin süresi dolmuş',
    invitationAlreadyPending: 'Bu e-postaya zaten bir davet gönderilmiş',
    invitationAccepted: 'Organizasyona başarıyla katıldınız',
    invitationEmailMismatch: 'Bu davet farklı bir e-posta adresine gönderilmiştir',
  },

  // Environment Variables
  envVars: {
    notFound: 'Ortam değişkeni bulunamadı',
    keyExists: 'Bu anahtarla bir ortam değişkeni zaten mevcut',
    invalidKeyFormat: 'Anahtar bir harfle başlamalı ve sadece büyük harf, rakam ve alt çizgi içermelidir',
    created: 'Ortam değişkeni başarıyla oluşturuldu',
    updated: 'Ortam değişkeni başarıyla güncellendi',
    deleted: 'Ortam değişkeni başarıyla silindi',
    bulkUpdated: 'Ortam değişkenleri başarıyla güncellendi',
  },

  // Domains
  domains: {
    notFound: 'Domain bulunamadı',
    alreadyExists: 'Bu domain zaten kullanımda',
    invalidFormat: 'Geçersiz domain formatı',
    created: 'Domain başarıyla eklendi',
    deleted: 'Domain başarıyla kaldırıldı',
    setPrimary: 'Birincil domain başarıyla güncellendi',
    verified: 'Domain başarıyla doğrulandı',
    noServerAssigned: 'Bu projeye sunucu atanmamış. Lütfen önce bir sunucu atayın.',
    serverNotReady: 'Sunucu hazır değil. Lütfen sunucu kurulumunun tamamlanmasını bekleyin.',
    dnsNotConfigured: 'DNS yapılandırılmamış. Lütfen sunucu IP\'sine işaret eden bir A kaydı ekleyin.',
    dnsConfigured: 'DNS doğru şekilde yapılandırılmış.',
    dnsPointsElsewhere: 'DNS farklı bir IP adresine işaret ediyor.',
    nginxUpdated: 'Nginx ayarları başarıyla güncellendi',
    nginxUpdateFailed: 'Nginx ayarları sunucuya uygulanamadı',
  },

  // Deployments
  deployments: {
    notFound: 'Deployment bulunamadı',
    created: 'Deployment başarıyla başlatıldı',
    cancelled: 'Deployment iptal edildi',
    projectPaused: 'Duraklatılmış projeye deployment yapılamaz',
    cannotCancel: 'Bu deployment iptal edilemez',
    cannotRollback: 'Bu deployment\'a geri alınamaz',
    rollbackStarted: 'Geri alma başarıyla başlatıldı',
    redeployStarted: 'Yeniden deployment başarıyla başlatıldı',
  },

  // Integrations
  integrations: {
    notConnected: 'GitHub bağlı değil',
    connected: 'GitHub başarıyla bağlandı',
    disconnected: 'GitHub bağlantısı kesildi',
    invalidState: 'Geçersiz OAuth durumu',
    oauthFailed: 'OAuth kimlik doğrulaması başarısız',
    notConfigured: 'GitHub OAuth yapılandırılmamış',
  },

  // Notifications
  notifications: {
    notFound: 'Bildirim kanalı bulunamadı',
    created: 'Bildirim kanalı başarıyla oluşturuldu',
    updated: 'Bildirim kanalı başarıyla güncellendi',
    deleted: 'Bildirim kanalı başarıyla silindi',
    testSent: 'Test bildirimi başarıyla gönderildi',
    testFailed: 'Test bildirimi gönderilemedi',
  },

  // Health Checks
  healthChecks: {
    enabled: 'Sağlık kontrolleri başarıyla etkinleştirildi',
    updated: 'Sağlık kontrolü yapılandırması başarıyla güncellendi',
    disabled: 'Sağlık kontrolleri başarıyla devre dışı bırakıldı',
  },

  // API Keys
  apiKeys: {
    notFound: 'API anahtarı bulunamadı',
    created: 'API anahtarı başarıyla oluşturuldu',
    revoked: 'API anahtarı başarıyla iptal edildi',
    updated: 'API anahtarı başarıyla güncellendi',
    invalidKey: 'Geçersiz veya süresi dolmuş API anahtarı',
    invalidScopes: 'Geçersiz yetki kapsamı belirtildi',
    insufficientScope: 'API anahtarı gerekli izinlere sahip değil',
    limitReached: 'Maksimum API anahtarı sayısına ulaşıldı',
  },

  // Two-Factor Authentication
  twoFactor: {
    setupRequired: '2FA kurulumu gerekli. Lütfen önce yeni bir anahtar oluşturun.',
    alreadyEnabled: '2FA zaten bu hesap için etkin',
    invalidCode: 'Geçersiz doğrulama kodu',
    notEnabled: '2FA bu hesap için etkin değil',
    noBackupCodes: 'Yedek kod mevcut değil',
    enabled: '2FA başarıyla etkinleştirildi',
    disabled: '2FA başarıyla devre dışı bırakıldı',
    backupCodesRegenerated: 'Yedek kodlar başarıyla yenilendi',
    verificationRequired: '2FA doğrulaması gerekli',
  },

  // Billing
  billing: {
    emailUpdated: 'Fatura e-postası başarıyla güncellendi',
  },

  // Servers
  servers: {
    notFound: 'Sunucu bulunamadı',
    created: 'Sunucu başarıyla oluşturuldu',
    deleted: 'Sunucu başarıyla silindi',
    started: 'Sunucu başarıyla başlatıldı',
    stopped: 'Sunucu başarıyla durduruldu',
    rebooted: 'Sunucu yeniden başlatma başlatıldı',
    createFailed: 'Sunucu oluşturulamadı',
    deleteFailed: 'Sunucu silinemedi',
    providerNotConfigured: 'Bulut sağlayıcısı yapılandırılmamış',
    notProvisioned: 'Sunucu henüz hazırlanmadı',
    quotaExceeded: 'Sunucu limitine ulaşıldı. Daha fazla sunucu oluşturmak için planınızı yükseltin.',
  },

  // Databases
  databases: {
    notFound: 'Veritabanı bulunamadı',
    nameExists: 'Bu isimde bir veritabanı zaten mevcut',
    serverNotReady: 'Seçilen sunucu veritabanı oluşturma için hazır değil',
    created: 'Veritabanı başarıyla oluşturuldu',
    updated: 'Veritabanı başarıyla güncellendi',
    deleted: 'Veritabanı başarıyla silindi',
    alreadyConnected: 'Veritabanı zaten bu projeye bağlı',
    connectionNotFound: 'Veritabanı bağlantısı bulunamadı',
    connected: 'Veritabanı projeye başarıyla bağlandı',
    disconnected: 'Veritabanı projeden başarıyla ayrıldı',
    mustBeRunning: 'Bu ayarı değiştirmek için veritabanı çalışıyor olmalı',
    invalidContainer: 'Veritabanı container yapılandırması geçersiz',
    externalAccessEnabled: 'Dış erişim başarıyla etkinleştirildi',
    externalAccessDisabled: 'Dış erişim başarıyla devre dışı bırakıldı',
    started: 'Veritabanı başarıyla başlatıldı',
    stopped: 'Veritabanı başarıyla durduruldu',
    restarted: 'Veritabanı başarıyla yeniden başlatıldı',
    passwordReset: 'Veritabanı şifresi başarıyla sıfırlandı',
    quotaExceeded: 'Veritabanı limitine ulaşıldı. Daha fazla veritabanı oluşturmak için planınızı yükseltin.',
    backupCreated: 'Yedek başarıyla oluşturuldu',
    backupFailed: 'Yedek oluşturma başarısız',
    backupNotFound: 'Yedek bulunamadı',
    backupDeleted: 'Yedek başarıyla silindi',
    backupRestored: 'Veritabanı yedekten başarıyla geri yüklendi',
    backupRestoreFailed: 'Veritabanı yedekten geri yükleme başarısız',
    backupInProgress: 'Bu veritabanı için zaten bir yedekleme işlemi devam ediyor',
    databaseMustBeRunning: 'Bu işlemi gerçekleştirmek için veritabanı çalışıyor olmalı',
  },
};
