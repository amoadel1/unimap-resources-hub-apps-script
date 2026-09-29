/**
 * Config.gs
 * Central configuration: app constants, sheet schemas, roles and setting definitions.
 *
 * Naming convention used across the project:
 *   - Functions ending with "_" are PRIVATE. Apps Script does not allow the browser
 *     (google.script.run) to call them.
 *   - Functions WITHOUT a trailing "_" are callable from the browser, so only a small,
 *     reviewed set of entry points exists (see Code.gs and Setup.gs).
 */

var APP = {
  NAME: 'UniMAP Resources Hub',
  VERSION: '2.1.0',
  SCHEMA_VERSION: 1,

  // Script Properties keys (server-side only, never sent to the browser)
  PROP_SPREADSHEET_ID: 'SPREADSHEET_ID',
  PROP_PEPPER: 'AUTH_PEPPER',
  PROP_INITIAL_ADMIN_EMAIL: 'INITIAL_ADMIN_EMAIL',
  PROP_PROXY_SECRET: 'PROXY_SHARED_SECRET', // enables the doPost API used by Cloudflare (Api.gs)

  // Cache keys
  CACHE_PUBLIC: 'pub_bundle_v1',
  CACHE_TTL_PUBLIC: 21600, // 6 hours (CacheService maximum)

  // Auth
  HASH_ITERATIONS: 1000,
  SESSION_ABSOLUTE_HOURS: 12,
  LOGIN_MAX_FAILS: 5,
  LOGIN_LOCK_MINUTES: 15,
  LOGIN_GLOBAL_MAX_FAILS: 40, // across all emails, per 15 minutes
  LOGIN_IP_MAX_FAILS: 20,     // per hashed client IP (Cloudflare API only), per 15 minutes
  RATE_LIMIT_IP_PER_HOUR: 20, // submissions per hashed client IP (Cloudflare API only); campus Wi-Fi shares IPs

  // Limits
  MAX_ACTIVITY_READ: 300,
  MAX_SUBMISSIONS_HISTORY: 1000
};

/** Role hierarchy. A higher number includes all permissions of lower numbers. */
var ROLES = {
  reviewer: 1, // review submissions, view content
  admin: 2,    // manage all content + submissions + content settings
  owner: 3     // everything, including admins and security settings
};

/**
 * Sheet schemas. Column order here is the order used when a sheet is created.
 * The data layer maps columns by HEADER NAME, so re-ordering columns or adding
 * extra columns manually in the spreadsheet will not break the app.
 *
 * Types: string | text (multi-line) | bool | number | date (ISO 8601 string)
 */
var SCHEMA = {
  Programmes: {
    key: 'id',
    prefix: 'prg',
    columns: [
      ['id', 'string'], ['slug', 'string'], ['code', 'string'],
      ['name', 'string'], ['name_ar', 'string'], ['faculty', 'string'],
      ['description', 'text'], ['description_ar', 'text'],
      ['is_active', 'bool'], ['sort_order', 'number'],
      ['created_at', 'date'], ['updated_at', 'date'],
      ['created_by', 'string'], ['updated_by', 'string']
    ]
  },
  Categories: {
    key: 'id',
    prefix: 'cat',
    columns: [
      ['id', 'string'], ['slug', 'string'],
      ['name', 'string'], ['name_ar', 'string'],
      ['description', 'text'], ['description_ar', 'text'],
      ['is_active', 'bool'], ['sort_order', 'number'],
      ['created_at', 'date'], ['updated_at', 'date']
    ]
  },
  Resources: {
    key: 'id',
    prefix: 'res',
    columns: [
      ['id', 'string'], ['programme_id', 'string'], ['category_id', 'string'],
      ['title', 'string'], ['owner_name', 'string'], ['intake', 'string'],
      ['platform', 'string'], ['url', 'string'], ['url_key', 'string'],
      ['notes', 'text'], ['is_official', 'bool'], ['is_active', 'bool'],
      ['sort_order', 'number'], ['source_submission_id', 'string'],
      ['created_at', 'date'], ['updated_at', 'date'],
      ['created_by', 'string'], ['updated_by', 'string']
    ]
  },
  Submissions: {
    key: 'id',
    prefix: 'sub',
    columns: [
      ['id', 'string'], ['resource_type', 'string'], ['full_name', 'string'],
      ['programme_id', 'string'], ['intake', 'string'], ['platform', 'string'],
      ['resource_url', 'string'], ['url_key', 'string'], ['notes', 'text'],
      ['status', 'string'], ['submitted_at', 'date'], ['reviewed_at', 'date'],
      ['reviewed_by', 'string'], ['admin_notes', 'text'], ['resource_id', 'string'],
      ['client_ref', 'string']
    ]
  },
  Platforms: {
    key: 'id',
    prefix: 'plt',
    columns: [
      ['id', 'string'], ['name', 'string'], ['is_active', 'bool'],
      ['sort_order', 'number'], ['created_at', 'date'], ['updated_at', 'date']
    ]
  },
  Admins: {
    key: 'id',
    prefix: 'adm',
    columns: [
      ['id', 'string'], ['name', 'string'], ['email', 'string'], ['role', 'string'],
      ['is_active', 'bool'], ['password_hash', 'string'],
      ['must_change_password', 'bool'], ['password_changed_at', 'date'],
      ['created_at', 'date'], ['updated_at', 'date'], ['last_login', 'date'],
      ['created_by', 'string']
    ]
  },
  Settings: {
    key: 'key',
    prefix: '',
    columns: [
      ['key', 'string'], ['value', 'text'], ['description', 'text'],
      ['updated_at', 'date'], ['updated_by', 'string']
    ]
  },
  ActivityLog: {
    key: 'id',
    prefix: 'log',
    columns: [
      ['id', 'string'], ['timestamp', 'date'], ['admin_email', 'string'],
      ['action', 'string'], ['entity_type', 'string'], ['entity_id', 'string'],
      ['details', 'text']
    ]
  }
};

var SHEET_ORDER = ['Programmes', 'Resources', 'Submissions', 'Categories', 'Platforms', 'Admins', 'Settings', 'ActivityLog'];

var DEFAULT_PLATFORMS = ['Google Drive', 'OneDrive', 'Box', 'Telegram', 'Website', 'Other'];

/**
 * Editable application settings.
 *  type:    text | longtext | bool | number | email | select
 *  public:  true  -> sent to the public website
 *  role:    minimum role that may edit the setting
 *  group:   dashboard grouping
 */
var SETTINGS_DEF = [
  // --- Branding & homepage ---
  { key: 'site_name', type: 'text', group: 'Branding', public: true, role: 'admin', max: 80,
    default: 'UniMAP Resources Hub', description: 'Site name shown in the header and page title.' },
  { key: 'tagline_en', type: 'text', group: 'Branding', public: true, role: 'admin', max: 120,
    default: 'By Students, For Students', description: 'Tagline (English).' },
  { key: 'tagline_ar', type: 'text', group: 'Branding', public: true, role: 'admin', max: 120,
    default: 'من الطلاب، للطلاب', description: 'Tagline (Arabic).' },
  { key: 'hero_description_en', type: 'longtext', group: 'Branding', public: true, role: 'admin', max: 600,
    default: 'Find academic drives, notes, past exams, lab materials and useful links shared by UniMAP students — organised by programme, in one place.',
    description: 'Homepage introduction (English).' },
  { key: 'hero_description_ar', type: 'longtext', group: 'Branding', public: true, role: 'admin', max: 600,
    default: 'اعثر على الدرايفات والملخصات والامتحانات السابقة ومواد المختبرات والروابط المفيدة التي شاركها طلاب UniMAP — منظّمة حسب التخصص وفي مكان واحد.',
    description: 'Homepage introduction (Arabic).' },
  { key: 'announcement_en', type: 'text', group: 'Branding', public: true, role: 'admin', max: 240,
    default: '', description: 'Optional announcement banner (English). Leave empty to hide.' },
  { key: 'announcement_ar', type: 'text', group: 'Branding', public: true, role: 'admin', max: 240,
    default: '', description: 'Optional announcement banner (Arabic). Leave empty to hide.' },

  // --- Notices & disclaimers ---
  { key: 'access_notice_en', type: 'longtext', group: 'Notices', public: true, role: 'admin', max: 500,
    default: 'Some resources require UniMAP authentication. If a Google Drive or university link does not open, sign in with your official UniMAP student email and try again.',
    description: 'Access notice shown on the homepage (English).' },
  { key: 'access_notice_ar', type: 'longtext', group: 'Notices', public: true, role: 'admin', max: 500,
    default: 'بعض المصادر تتطلب تسجيل الدخول بحساب UniMAP. إذا لم يفتح رابط Google Drive أو رابط الجامعة، سجّل الدخول ببريدك الجامعي الرسمي ثم حاول مرة أخرى.',
    description: 'Access notice shown on the homepage (Arabic).' },
  { key: 'disclaimer_en', type: 'longtext', group: 'Notices', public: true, role: 'admin', max: 600,
    default: 'UniMAP Resources Hub is an independent student initiative. It is not an official UniMAP system and is not owned, operated or endorsed by Universiti Malaysia Perlis. The hub does not host files — it only links to resources owned by their respective creators.',
    description: 'Independence disclaimer (English). Shown in the footer and About page.' },
  { key: 'disclaimer_ar', type: 'longtext', group: 'Notices', public: true, role: 'admin', max: 600,
    default: 'منصة مصادر UniMAP مبادرة طلابية مستقلة، وليست نظامًا رسميًا لجامعة ماليزيا بيرليس ولا تملكها الجامعة أو تديرها أو تعتمدها. المنصة لا تستضيف أي ملفات، بل تكتفي بالربط بمصادر يملكها أصحابها.',
    description: 'Independence disclaimer (Arabic).' },
  { key: 'official_intro_en', type: 'longtext', group: 'Notices', public: true, role: 'admin', max: 500,
    default: 'Links to official academic guides, programme structures, course lists and timetables published by UniMAP. These links point to UniMAP’s own websites — this hub itself remains an independent student initiative.',
    description: 'Introduction for the Official Resources section (English).' },
  { key: 'official_intro_ar', type: 'longtext', group: 'Notices', public: true, role: 'admin', max: 500,
    default: 'روابط للأدلة الأكاديمية وهياكل البرامج وقوائم المواد والجداول الدراسية التي تنشرها جامعة UniMAP. هذه الروابط تقود إلى مواقع الجامعة نفسها، بينما تبقى هذه المنصة مبادرة طلابية مستقلة.',
    description: 'Introduction for the Official Resources section (Arabic).' },

  // --- Welcome message ---
  { key: 'show_welcome', type: 'bool', group: 'Welcome message', public: true, role: 'admin',
    default: 'TRUE', description: 'Show the welcome message on the homepage.' },
  { key: 'welcome_en', type: 'longtext', group: 'Welcome message', public: true, role: 'admin', max: 4000,
    default: [
      'Welcome to the UniMAP Student Resources Hub.',
      'This platform was created and is maintained by ADEL HUSHAM MOHAMEDAIN to collect and organise academic resources in one place, making educational materials easier to access for current and future UniMAP students.',
      'All drives, links and materials belong to their respective owners and contributors. We do not claim ownership of any content.',
      'If any resource owner wishes to update or remove their resource, they may contact us and the request will be handled respectfully.',
      'We sincerely appreciate everyone who contributes to maintaining and sharing educational resources that benefit the student community.'
    ].join('\n\n'),
    description: 'Welcome message (English). Separate paragraphs with a blank line.' },
  { key: 'welcome_ar', type: 'longtext', group: 'Welcome message', public: true, role: 'admin', max: 4000,
    default: [
      'مرحباً بكم في منصة مصادر طلاب جامعة ماليزيا بيرليس (UniMAP).',
      'تم إنشاء هذه المنصة وإدارتها بواسطة الطالب عادل هشام محمدين بهدف جمع وتنظيم المصادر الدراسية في مكان واحد لتسهيل الوصول إليها والاستفادة منها من قبل جميع الطلاب.',
      'جميع الدرايفات والروابط والملفات المعروضة هنا تعود إلى أصحابها الذين قاموا بإنشائها أو مشاركتها، ولا ندّعي ملكية أي من هذه المواد. يقتصر دور المنصة على جمع وتنظيم المصادر المتاحة لخدمة المجتمع الطلابي.',
      'نتقدم بالشكر والتقدير لكل طالب ساهم في إنشاء أو مشاركة هذه المصادر، ونسأل الله أن يجزيهم خير الجزاء وأن يجعل علمهم وعملهم نافعًا للجميع.',
      'أعتذر مقدمًا لأي شخص تمت إضافة رابط درايفه أو مصدره إلى هذه المنصة دون التواصل معه أو أخذ إذن مباشر منه. لم يكن الهدف سوى جمع المصادر المتاحة وتنظيمها في مكان واحد ليستفيد منها الطلاب.',
      'وفي حال رغب أي صاحب مصدر بتعديل بياناته أو إزالة رابطه من المنصة، يمكنه التواصل معي وسيتم التعامل مع طلبه بكل احترام.',
      'كما أتمنى من جميع أصحاب المصادر الاستمرار في تحديث ورفع ملفاتهم ومشاركة ما يستطيعون من مواد علمية، فكل طالب ينتفع بهذه الملفات هو أجر لكم بإذن الله، وصدقة علم جارية، ومساهمة قيمة في خدمة إخوانكم الطلاب.'
    ].join('\n\n'),
    description: 'Welcome message (Arabic). Separate paragraphs with a blank line.' },

  // --- Maintainer & contact ---
  { key: 'maintainer_name', type: 'text', group: 'Maintainer & contact', public: true, role: 'admin', max: 120,
    default: 'ADEL HUSHAM MOHAMEDAIN', description: 'Maintainer name (English).' },
  { key: 'maintainer_name_ar', type: 'text', group: 'Maintainer & contact', public: true, role: 'admin', max: 120,
    default: 'عادل هشام محمدين', description: 'Maintainer name (Arabic).' },
  { key: 'maintainer_role', type: 'text', group: 'Maintainer & contact', public: true, role: 'admin', max: 120,
    default: 'Founder & Maintainer', description: 'Maintainer role (English).' },
  { key: 'maintainer_role_ar', type: 'text', group: 'Maintainer & contact', public: true, role: 'admin', max: 120,
    default: 'المؤسس والمشرف', description: 'Maintainer role (Arabic).' },
  { key: 'contact_email', type: 'email', group: 'Maintainer & contact', public: true, role: 'admin', max: 160,
    default: 'adelaljaale@gmail.com', description: 'Public contact email for enquiries, broken links and removal requests.' },

  // --- Language ---
  { key: 'default_language', type: 'select', options: ['en', 'ar'], group: 'Language', public: true, role: 'admin',
    default: 'en', description: 'Default language for first-time visitors.' },

  // --- Submissions ---
  { key: 'submissions_enabled', type: 'bool', group: 'Submissions', public: true, role: 'admin',
    default: 'TRUE', description: 'Allow students to submit new resources.' },
  { key: 'require_https', type: 'bool', group: 'Submissions', public: false, role: 'owner',
    default: 'FALSE', description: 'Only accept https:// links (http:// links will be rejected).' },
  { key: 'rate_limit_client_per_hour', type: 'number', group: 'Submissions', public: false, role: 'owner', min: 1, max: 100,
    default: '5', description: 'Maximum submissions per browser per hour.' },
  { key: 'rate_limit_global_per_hour', type: 'number', group: 'Submissions', public: false, role: 'owner', min: 5, max: 2000,
    default: '60', description: 'Maximum submissions for the whole site per hour (spam protection).' },

  // --- Security ---
  { key: 'session_idle_minutes', type: 'number', group: 'Security', public: false, role: 'owner', min: 10, max: 360,
    default: '120', description: 'Admin sessions expire after this many minutes of inactivity (max 360).' }
];

/** Returns the setting definition for a key, or null. */
function settingDef_(key) {
  for (var i = 0; i < SETTINGS_DEF.length; i++) {
    if (SETTINGS_DEF[i].key === key) return SETTINGS_DEF[i];
  }
  return null;
}
