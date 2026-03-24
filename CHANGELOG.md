# Changelog

All notable changes to this project will be documented in this file.

## [1.3.0] - 2026-03-24

### Added

- `apply-batch` skill for applying to multiple jobs from a file of URLs with scoring and batch approval
- `jobs-to-apply.example.txt` template file for batch apply

## [1.2.0] - 2026-03-22

### Added

- Persistent applied-jobs database (`applied-jobs.json`) to prevent duplicate applications across runs and skills
- `scripts/check-applied.sh` to check if a job URL was already applied to
- `scripts/log-applied.sh` to log successful applications to the database
- Relocation preferences (`willingToRelocate`, `preferredLocations`) in work authorization config
- Strengthened `browser_snapshot` guidance to always use `ref` parameter for targeted snapshots

### Changed

- All shell scripts now use `jq` only (removed `node` and `python3` fallbacks) for simpler permissions
- Improved context window efficiency with targeted browser snapshots

## [1.1.0] - 2026-03-22

### Added

- `dashboard` skill for application tracking stats and CSV export
- Multi-resume support (`personal.resumes` in profile.json)
- Salary range filter (`minSalary`/`maxSalary` in autopilot config)
- Smart retry with `retryNotes` on failed applications for better retry strategies
- `scripts/run-stats.sh` for aggregating stats across runs
- `scripts/export-csv.sh` for exporting applications to CSV

## [1.0.0] - 2026-03-21

### Added

- Initial release of JobPilot plugin
- `apply` skill for automated job application form filling via Playwright
- `cover-letter` skill for generating tailored cover letters
- `upwork-proposal` skill for generating Upwork proposals
- `search` skill for searching and ranking job board results
- `interview` skill for generating interview prep Q&A
- `humanizer` submodule integration for natural tone rewriting
- Profile system with `profile.json` for storing personal info and credentials
- Job board configuration support (LinkedIn, Indeed)

- `autopilot` skill for autonomous batch job applications
- Progress tracking in `runs/` directory with resumable JSON files
- Autopilot configuration section in `profile.json` (minMatchScore, maxApplicationsPerRun, skipCompanies, skipTitleKeywords, defaultStartDate)
- Resume and retry-failed support for interrupted or failed autopilot runs
