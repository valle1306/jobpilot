# Browser Tips

## Handling Large Pages

Job board pages can be very large and cause token overflow errors when Playwright returns the full page snapshot. To avoid this:

1. **Use targeted snapshots.** If a full snapshot causes a token overflow, use `browser_snapshot` with a `ref` parameter to get only a specific element's subtree (e.g., the form container, the results list) instead of the entire page.
2. **Avoid redundant snapshots.** Actions like `browser_click` and `browser_type` return a snapshot automatically. If you get a token overflow error from an action's response, do NOT retry the same action. Instead, use a targeted `browser_snapshot` with a `ref` to read just the part of the page you need.
3. **When a tool returns a token overflow error**, the result is saved to a file. Use the `Read` tool with `offset` and `limit` to read portions of that file, or use `Grep` to search within it for specific content (e.g., job titles, form fields). **Do NOT use inline Python/Node scripts to parse these files** -- always use the built-in `Read` and `Grep` tools instead, as inline scripts trigger permission prompts.
4. **Prefer `browser_snapshot`** over relying on action return values for page state assessment on large pages.

## General Best Practices

1. **Handle popups and modals** -- close cookie banners, notification prompts, and overlays that block forms.
2. **Be patient with page loads** -- use `browser_wait_for` after navigation and form submissions.
3. **Take snapshots frequently** -- after every major action (navigation, form fill, submit) to verify state.
4. **If something goes wrong** (unexpected page, error, crashed form), take a snapshot and report to the user with what you see rather than guessing.
5. **For file uploads**, verify the resume file exists at the path in `profile.json`. If not, tell the user.
6. **Never guess passwords** -- always read from profile.json credentials.
