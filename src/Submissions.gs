/**
 * Submissions.gs
 * Public resource submissions and the admin review workflow.
 *
 * Flow: student submits → row in "Submissions" with status=pending →
 *       admin approves (resource is created, submission marked approved)
 *       or rejects (submission marked rejected, with optional admin notes).
 */

var SUBMISSION_STATUSES_ = ['pending', 'approved', 'rejected'];

/**
 * Validates and stores a public submission. Called via submitResource() in Code.gs.
 * Nothing sent by the browser is trusted: every field is re-validated here.
 */
function submissionCreate_(form) {
  if (!isPlainObject_(form)) throw appError_('VALIDATION', 'Invalid submission.');
  var settings = settingsMap_();
  if (!toBool_(settings.submissions_enabled)) {
    throw appError_('SUBMISSIONS_CLOSED', 'Submissions are temporarily closed. Please try again later.');
  }

  // Honeypot: real users never see or fill the hidden "website" field.
  // Bots get a normal-looking success response and nothing is stored.
  if (cleanLine_(form.website)) return { received: true };
  var elapsed = toNum_(form.elapsed_ms, -1);
  if (elapsed >= 0 && elapsed < 2500) return { received: true }; // form filled faster than humanly possible

  var type = String(form.resource_type || 'student');
  if (type !== 'student' && type !== 'official') throw appError_('INVALID_OPTION', 'Invalid resource type.', 'resource_type');
  var isOfficial = type === 'official';

  var fullName = field_(form.full_name, 'full_name', { label: 'Full name', required: true, min: 2, max: 140 });

  var programmeId = cleanLine_(form.programme_id);
  if (!isOfficial) {
    if (!programmeId) throw appError_('REQUIRED', 'Please choose a programme.', 'programme_id');
    var prog = db_get_('Programmes', programmeId);
    if (!prog || !prog.is_active) throw appError_('INVALID_OPTION', 'Please choose a valid programme.', 'programme_id');
  } else {
    programmeId = '';
  }

  var intake = isOfficial ? 'Official' : field_(form.intake, 'intake', { label: 'Intake', required: true, max: 40 });

  var platform = platformByName_(form.platform, true);
  if (!platform) throw appError_('INVALID_OPTION', 'Please choose a valid platform.', 'platform');

  var u = validateUrl_(form.resource_url, { field: 'resource_url', requireHttps: toBool_(settings.require_https) });
  var notes = field_(form.notes, 'notes', { label: 'Notes', max: 1000, multiline: true });

  var clientRef = cleanLine_(form.client_id);
  if (!/^[a-z0-9]{16,64}$/.test(clientRef)) clientRef = '';

  // Rate limits (fixed one-hour windows). Apps Script cannot see the visitor's IP
  // address, so limits are per browser (client_id) and site-wide.
  var hour = Math.floor(Date.now() / 3600000);
  var perClient = Math.max(1, toNum_(settings.rate_limit_client_per_hour, 5));
  var perSite = Math.max(5, toNum_(settings.rate_limit_global_per_hour, 60));
  var clientKey = clientRef ? 'rl:c:' + clientRef + ':' + hour : null;
  var globalKey = 'rl:g:' + hour;
  var ipHash = apiClientIpHash_(); // only present for requests coming through the Cloudflare API
  var ipKey = ipHash ? 'rl:i:' + ipHash.slice(0, 40) + ':' + hour : null;
  if ((clientKey && cacheCount_(clientKey) >= perClient) || cacheCount_(globalKey) >= perSite ||
      (ipKey && cacheCount_(ipKey) >= APP.RATE_LIMIT_IP_PER_HOUR)) {
    throw appError_('RATE_LIMITED', 'Too many submissions. Please try again later.');
  }

  return withLock_(function () {
    // Duplicate protection (checked inside the lock so two identical submissions
    // arriving at the same time cannot both be stored).
    db_rows_('Resources').forEach(function (r) {
      if (r.url_key !== u.key) return;
      if (isOfficial ? r.is_official : (!r.is_official && r.programme_id === programmeId)) {
        throw appError_('DUPLICATE_RESOURCE', 'This link is already listed on the hub.', 'resource_url');
      }
    });
    db_rows_('Submissions').forEach(function (s) {
      if (s.status === 'pending' && s.url_key === u.key) {
        throw appError_('DUPLICATE_PENDING', 'This link has already been submitted and is waiting for review.', 'resource_url');
      }
    });

    if (clientKey) cacheIncr_(clientKey, 3700);
    if (ipKey) cacheIncr_(ipKey, 3700);
    cacheIncr_(globalKey, 3700);

    var sub = db_insert_('Submissions', {
      id: newId_(SCHEMA.Submissions.prefix),
      resource_type: type,
      full_name: fullName,
      programme_id: programmeId,
      intake: intake,
      platform: platform.name,
      resource_url: u.url,
      url_key: u.key,
      notes: notes,
      status: 'pending',
      submitted_at: nowIso_(),
      reviewed_at: '', reviewed_by: '', admin_notes: '', resource_id: '',
      client_ref: clientRef ? clientRef.slice(0, 12) : ''
    });
    logActivity_(null, 'submission.create', 'submission', sub.id, fullName + ' — ' + (isOfficial ? 'official link' : intake));
    return { received: true };
  });
}

function defaultResourceTitle_(sub) {
  var p = sub.platform === 'Google Drive' ? 'Drive' : sub.platform;
  if (sub.resource_type === 'official') return field_(sub.full_name + ' — Official link', 'title', { max: 180 });
  return (sub.full_name + ' ' + p).slice(0, 180);
}

function pick_(p, key, fallback) {
  return (p && p[key] !== undefined && p[key] !== null) ? p[key] : fallback;
}

/**
 * Approves a pending submission: creates the resource (with the SAME programme_id),
 * marks the submission approved, and logs both actions. Admins may adjust fields
 * (title, programme, collection, notes...) before approving.
 */
function submissionApprove_(admin, p) {
  return withLock_(function () {
    var sub = db_get_('Submissions', p.id);
    if (!sub) throw appError_('NOT_FOUND', 'This submission no longer exists. Please refresh.');
    if (sub.status !== 'pending') {
      throw appError_('INVALID_STATE', 'This submission was already ' + sub.status + ' by ' + (sub.reviewed_by || 'another admin') + '.');
    }
    var isOfficial = sub.resource_type === 'official';
    var o = isPlainObject_(p.resource) ? p.resource : {};
    var input = {
      is_official: pick_(o, 'is_official', isOfficial),
      title: pick_(o, 'title', '') || defaultResourceTitle_(sub),
      owner_name: pick_(o, 'owner_name', '') || sub.full_name,
      intake: pick_(o, 'intake', sub.intake),
      platform: pick_(o, 'platform', sub.platform),
      url: pick_(o, 'url', sub.resource_url),
      notes: pick_(o, 'notes', sub.notes),
      programme_id: pick_(o, 'programme_id', sub.programme_id),
      category_id: pick_(o, 'category_id', ''),
      sort_order: pick_(o, 'sort_order', 0),
      is_active: true
    };
    var clean = resourceClean_(input, null);
    var adminNotes = field_(p.admin_notes, 'admin_notes', { label: 'Admin notes', max: 1000, multiline: true });
    var resource = resourceInsert_(admin, clean, sub.id);
    db_update_('Submissions', sub.id, {
      status: 'approved', reviewed_at: nowIso_(), reviewed_by: admin.email,
      admin_notes: adminNotes, resource_id: resource.id
    });
    logActivity_(admin, 'submission.approve', 'submission', sub.id,
      'Approved "' + resource.title + '" → resource ' + resource.id);
    return { submission_id: sub.id, resource_id: resource.id };
  });
}

function submissionReject_(admin, p) {
  return withLock_(function () {
    var sub = db_get_('Submissions', p.id);
    if (!sub) throw appError_('NOT_FOUND', 'This submission no longer exists. Please refresh.');
    if (sub.status !== 'pending') {
      throw appError_('INVALID_STATE', 'This submission was already ' + sub.status + ' by ' + (sub.reviewed_by || 'another admin') + '.');
    }
    var adminNotes = field_(p.admin_notes, 'admin_notes', { label: 'Admin notes', max: 1000, multiline: true });
    db_update_('Submissions', sub.id, {
      status: 'rejected', reviewed_at: nowIso_(), reviewed_by: admin.email, admin_notes: adminNotes
    });
    logActivity_(admin, 'submission.reject', 'submission', sub.id,
      'Rejected submission from ' + sub.full_name + (adminNotes ? ' — ' + adminNotes.slice(0, 200) : ''));
    return { submission_id: sub.id };
  });
}

/** Moves a rejected submission back to pending (e.g. rejected by mistake). */
function submissionReopen_(admin, p) {
  return withLock_(function () {
    var sub = db_get_('Submissions', p.id);
    if (!sub) throw appError_('NOT_FOUND', 'This submission no longer exists. Please refresh.');
    if (sub.status !== 'rejected') throw appError_('INVALID_STATE', 'Only rejected submissions can be reopened.');
    db_update_('Submissions', sub.id, { status: 'pending', reviewed_at: '', reviewed_by: '' });
    logActivity_(admin, 'submission.reopen', 'submission', sub.id, 'Reopened submission from ' + sub.full_name);
    return { submission_id: sub.id };
  });
}

function submissionSaveNotes_(admin, p) {
  return withLock_(function () {
    var sub = db_get_('Submissions', p.id);
    if (!sub) throw appError_('NOT_FOUND', 'This submission no longer exists. Please refresh.');
    var notes = field_(p.admin_notes, 'admin_notes', { label: 'Admin notes', max: 1000, multiline: true });
    db_update_('Submissions', sub.id, { admin_notes: notes });
    logActivity_(admin, 'submission.notes', 'submission', sub.id, 'Updated admin notes');
    return { submission_id: sub.id };
  });
}

/** Permanently deletes reviewed submissions (e.g. spam cleanup). Pending ones must be reviewed first. */
function submissionDelete_(admin, p) {
  var ids = Array.isArray(p.ids) ? p.ids.map(String) : (p.id ? [String(p.id)] : []);
  if (!ids.length || ids.length > 500) throw appError_('VALIDATION', 'Select between 1 and 500 submissions.');
  return withLock_(function () {
    ids.forEach(function (id) {
      var s = db_get_('Submissions', id);
      if (!s) throw appError_('NOT_FOUND', 'Some submissions no longer exist. Please refresh.');
      if (s.status === 'pending') throw appError_('INVALID_STATE', 'Pending submissions must be approved or rejected before deleting.');
    });
    db_delete_('Submissions', ids);
    logActivity_(admin, 'submission.delete', 'submission', ids.length === 1 ? ids[0] : '', 'Deleted ' + ids.length + ' reviewed submission(s)');
    return { count: ids.length };
  });
}
