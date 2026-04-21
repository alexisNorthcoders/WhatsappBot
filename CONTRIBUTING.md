# Contributing

Before you start work on a **new** GitHub issue, sync with `main` and use a dedicated branch so changes land through a pull request.

## Workflow

1. **Checkout `main`**

   ```bash
   git checkout main
   ```

2. **Pull the latest changes from `origin/main`**

   ```bash
   git pull origin main
   ```

3. **Create a branch for the issue** (pick a name that matches the issue, for example `issue/42-short-description`)

   ```bash
   git checkout -b your-branch-name
   ```

4. **Make the required changes and commit them**

   ```bash
   git add …
   git commit -m "Describe the change"
   ```

5. **Push the branch to the remote**

   ```bash
   git push -u origin your-branch-name
   ```

6. **Open a pull request targeting `main`**  
   Use the GitHub web UI, or [GitHub CLI](https://cli.github.com/):

   ```bash
   gh pr create --base main --head your-branch-name
   ```

Keeping `main` up to date before branching reduces merge conflicts and keeps review focused on the issue you are solving.
