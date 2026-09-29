/**
 * Migrate.gs
 * Optional one-time import of LIVE data exported from the old Supabase database
 * (anything added after supabase/schema.sql was written).
 *
 * How to use (see docs/MIGRATION.md):
 *   1. In Supabase → Table editor, export the tables "programmes", "resources"
 *      and (optionally) "submissions" as CSV.
 *   2. In the hub spreadsheet: File → Import → Upload → "Insert new sheet(s)" for each
 *      CSV, and rename the new tabs to: import_programmes, import_resources,
 *      import_submissions.
 *   3. Run importFromSupabase() from the Apps Script editor and read the log.
 *   4. Check the dashboard, then delete the import_* tabs.
 *
 * It is idempotent: programmes are matched by slug, resources by normalised link
 * (per programme / official), submissions by their original ID.
 */

function importFromSupabase() {
  var email = assertEditor_();
  var result = importFromSupabase_({ email: email });
  Logger.log('Import finished:');
  Object.keys(result).forEach(function (k) {
    Logger.log('  ' + k + ': ' + (Array.isArray(result[k]) ? result[k].length + (result[k].length ? ' → ' + result[k].slice(0, 20).join(' | ') : '') : result[k]));
  });
  return result;
}

function readImportSheet_(name) {
  var sh = db_ss_().getSheetByName(name);
  if (!sh) return null;
  var values = sh.getDataRange().getValues();
  if (values.length < 2) return [];
  var header = values[0].map(function (h) { return String(h).trim().toLowerCase(); });
  return values.slice(1).filter(function (row) {
    return row.some(function (v) { return String(v).trim() !== ''; });
  }).map(function (row) {
    var o = {};
    header.forEach(function (h, i) { if (h) o[h] = row[i] instanceof Date ? row[i].toISOString() : String(row[i] === null ? '' : row[i]).trim(); });
    return o;
  });
}

function importFromSupabase_(actor) {
  var progIn = readImportSheet_('import_programmes');
  var resIn = readImportSheet_('import_resources');
  var subIn = readImportSheet_('import_submissions');
  if (!progIn && !resIn && !subIn) {
    throw new Error('No import sheets found. Create tabs named import_programmes / import_resources / import_submissions first.');
  }

  return withLock_(function () {
    var now = nowIso_();
    var report = {
      programmes_created: 0, programmes_matched: 0, resources_created: 0, resources_skipped_duplicate: 0,
      submissions_created: 0, submissions_skipped: 0, platforms_created: 0, problems: []
    };

    // ---- Programmes (match by slug, else by name)
    var progMap = {};
    var bySlug = {}, byName = {};
    db_rows_('Programmes').forEach(function (p) { bySlug[p.slug] = p; byName[p.name.toLowerCase()] = p; });
    var sort = nextSortOrder_('Programmes');
    var newProgs = [];
    (progIn || []).forEach(function (p) {
      var slug = slugify_(p.slug || p.name);
      var existing = bySlug[slug] || byName[String(p.name || '').toLowerCase()];
      if (existing) { progMap[p.id] = existing.id; report.programmes_matched++; return; }
      var name = cleanLine_(p.name).slice(0, 160);
      if (name.length < 3 || !slug) { report.problems.push('Programme skipped (no name): ' + p.id); return; }
      var row = {
        id: newId_(SCHEMA.Programmes.prefix), slug: slug, code: '', name: name, name_ar: '',
        faculty: cleanLine_(p.faculty).slice(0, 160), description: cleanText_(p.description).slice(0, 1200), description_ar: '',
        is_active: p.is_active === '' ? true : toBool_(p.is_active), sort_order: sort,
        created_at: p.created_at || now, updated_at: now, created_by: actor.email, updated_by: actor.email
      };
      sort += 10;
      newProgs.push(row);
      bySlug[slug] = row; byName[name.toLowerCase()] = row;
      progMap[p.id] = row.id;
    });
    db_insertMany_('Programmes', newProgs);
    report.programmes_created = newProgs.length;

    // ---- Platforms used by imported rows must exist
    var platformNames = {};
    db_rows_('Platforms').forEach(function (p) { platformNames[p.name.toLowerCase()] = p.name; });
    var newPlatforms = [];
    function platformFor(name) {
      var n = cleanLine_(name) || 'Other';
      var key = n.toLowerCase();
      if (platformNames[key]) return platformNames[key];
      var row = { id: newId_(SCHEMA.Platforms.prefix), name: n.slice(0, 40), is_active: true, sort_order: 900 + newPlatforms.length * 10, created_at: now, updated_at: now };
      newPlatforms.push(row);
      platformNames[key] = row.name;
      return row.name;
    }

    // ---- Resources (dedupe by link within the same place)
    var seen = {};
    db_rows_('Resources').forEach(function (r) {
      seen[r.url_key + '|' + (r.is_official ? 'o' : 'p:' + r.programme_id)] = true;
    });
    var newRes = [];
    (resIn || []).forEach(function (r) {
      var official = toBool_(r.is_official);
      var pid = r.programme_id ? progMap[r.programme_id] || '' : '';
      if (!official && !pid) { report.problems.push('Resource without programme skipped: ' + (r.title || r.id)); return; }
      var u;
      try { u = validateUrl_(r.url); } catch (e) { report.problems.push('Invalid link skipped: ' + (r.title || r.id)); return; }
      var k = u.key + '|' + (official ? 'o' : 'p:' + pid);
      if (seen[k]) { report.resources_skipped_duplicate++; return; }
      seen[k] = true;
      newRes.push({
        id: newId_(SCHEMA.Resources.prefix), programme_id: pid, category_id: '',
        title: (cleanLine_(r.title) || 'Untitled resource').slice(0, 180), owner_name: (cleanLine_(r.owner_name) || 'Unknown').slice(0, 140),
        intake: (cleanLine_(r.intake) || (official ? 'Official' : 'Unknown')).slice(0, 40), platform: platformFor(r.platform),
        url: u.url, url_key: u.key, notes: cleanText_(r.notes).slice(0, 1000), is_official: official,
        is_active: r.is_active === '' ? true : toBool_(r.is_active), sort_order: 0, source_submission_id: '',
        created_at: r.created_at || now, updated_at: now, created_by: actor.email, updated_by: actor.email
      });
    });

    // ---- Submissions (keep original IDs so re-running is safe)
    var newSubs = [];
    var subIds = {};
    db_rows_('Submissions').forEach(function (s) { subIds[s.id] = true; });
    (subIn || []).forEach(function (s) {
      var id = 'sub_' + String(s.id || '').replace(/[^a-zA-Z0-9]/g, '').slice(0, 32);
      if (!s.id || subIds[id]) { report.submissions_skipped++; return; }
      var u;
      try { u = validateUrl_(s.resource_url); } catch (e) { report.problems.push('Submission with invalid link skipped: ' + s.id); return; }
      var status = SUBMISSION_STATUSES_.indexOf(s.status) === -1 ? 'pending' : s.status;
      subIds[id] = true;
      newSubs.push({
        id: id, resource_type: s.programme_id ? 'student' : 'official', full_name: cleanLine_(s.full_name).slice(0, 140) || 'Unknown',
        programme_id: s.programme_id ? progMap[s.programme_id] || '' : '', intake: cleanLine_(s.intake).slice(0, 40) || (s.programme_id ? '' : 'Official'),
        platform: platformFor(s.platform), resource_url: u.url, url_key: u.key, notes: cleanText_(s.notes).slice(0, 1000),
        status: status, submitted_at: s.created_at || now, reviewed_at: s.reviewed_at || '',
        reviewed_by: s.reviewed_at ? 'supabase-import' : '', admin_notes: 'Imported from Supabase', resource_id: '', client_ref: ''
      });
    });

    db_insertMany_('Platforms', newPlatforms);
    db_insertMany_('Resources', newRes);
    db_insertMany_('Submissions', newSubs);
    report.platforms_created = newPlatforms.length;
    report.resources_created = newRes.length;
    report.submissions_created = newSubs.length;
    logActivity_(actor, 'system.import', 'system', '', JSON.stringify({
      programmes: report.programmes_created, resources: report.resources_created, submissions: report.submissions_created
    }));
    invalidatePublicCache_();
    return report;
  });
}
