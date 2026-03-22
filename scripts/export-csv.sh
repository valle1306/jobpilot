#!/usr/bin/env bash
# Exports all applied/failed jobs from run history to CSV.
# Usage: bash scripts/export-csv.sh [runs_dir] [output_file]
# Output: CSV file with headers: status,title,company,location,board,score,url,appliedAt,failReason,runId,query

RUNS_DIR="${1:-${CLAUDE_PLUGIN_ROOT:-.}/runs}"
OUTPUT="${2:-${CLAUDE_PLUGIN_ROOT:-.}/job-applications.csv}"

if [ ! -d "$RUNS_DIR" ] || [ -z "$(ls -A "$RUNS_DIR" 2>/dev/null)" ]; then
  echo "No run files found in $RUNS_DIR"
  exit 0
fi

if command -v node &>/dev/null; then
  node -e "
    const fs = require('fs'), path = require('path');
    const dir = process.argv[1], out = process.argv[2];
    const escape = (s) => {
      if (!s) return '';
      s = String(s);
      return s.includes(',') || s.includes('\"') || s.includes('\n') ? '\"' + s.replace(/\"/g, '\"\"') + '\"' : s;
    };
    const lines = ['status,title,company,location,board,score,url,appliedAt,failReason,runId,query'];
    for (const f of fs.readdirSync(dir).filter(f => f.endsWith('.json'))) {
      try {
        const run = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
        for (const job of (run.jobs || [])) {
          if (job.status === 'applied' || job.status === 'failed') {
            lines.push([
              escape(job.status), escape(job.title), escape(job.company),
              escape(job.location), escape(job.board), job.matchScore || '',
              escape(job.url), escape(job.appliedAt || ''),
              escape(job.failReason || ''), escape(run.runId), escape(run.query)
            ].join(','));
          }
        }
      } catch(e) {}
    }
    fs.writeFileSync(out, lines.join('\n') + '\n');
    console.log('Exported ' + (lines.length - 1) + ' jobs to ' + out);
  " "$RUNS_DIR" "$OUTPUT"
elif command -v python3 &>/dev/null; then
  python3 -c "
import csv, json, os, sys
d, out = sys.argv[1], sys.argv[2]
rows = []
for f in sorted(os.listdir(d)):
    if not f.endswith('.json'): continue
    try:
        run = json.load(open(os.path.join(d, f)))
        for job in run.get('jobs', []):
            if job.get('status') in ('applied', 'failed'):
                rows.append({
                    'status': job.get('status',''), 'title': job.get('title',''),
                    'company': job.get('company',''), 'location': job.get('location',''),
                    'board': job.get('board',''), 'score': job.get('matchScore',''),
                    'url': job.get('url',''), 'appliedAt': job.get('appliedAt',''),
                    'failReason': job.get('failReason',''), 'runId': run.get('runId',''),
                    'query': run.get('query','')
                })
    except: pass
with open(out, 'w', newline='') as f:
    w = csv.DictWriter(f, fieldnames=['status','title','company','location','board','score','url','appliedAt','failReason','runId','query'])
    w.writeheader()
    w.writerows(rows)
print(f'Exported {len(rows)} jobs to {out}')
" "$RUNS_DIR" "$OUTPUT"
else
  echo "No runtime available (need node or python3)"
fi
