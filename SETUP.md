# Putting Lights Out online with the AI coach

Your website (GitHub Pages) sends check-in data to a small server (a Cloudflare Worker). The server holds your secret Claude API key, asks Claude for recommendations, and sends them back. The key never appears in your website's code.

```
Browser (index.html)  ──check-ins──▶  Cloudflare Worker (worker.js + secret key)  ──▶  Claude API
                      ◀──3 recs────                                              ◀──
```

Plan for about 45 minutes. Do the steps in order.

## 1. Get a Claude API key (needs a parent or guardian)

Anthropic's API accounts generally require an adult, so have a parent or guardian do this part.

1. Go to https://platform.claude.com and create an account.
2. Add billing and **set a monthly spending limit** (for example, $5). The coach uses a fast, low-cost model, but a limit protects you if someone spams your site.
3. Create an API key and copy it. You'll only see it once.

**Never** paste the key into `index.html`, a GitHub file, or a screenshot.

## 2. Put the website on GitHub Pages

1. Create a free account at https://github.com.
2. Create a new **public** repository, for example `lights-out`.
3. Upload `index.html` (and `worker.js` so judges can see your server code).
4. Go to the repository's **Settings → Pages**. Under "Build and deployment," choose **Deploy from a branch**, pick `main` and `/ (root)`, and save.
5. After a minute or two, your site is at `https://YOUR-USERNAME.github.io/lights-out/`.

## 3. Create the server on Cloudflare

1. Create a free account at https://dash.cloudflare.com.
2. Open **Workers & Pages**, then create a new Worker. Name it `lights-out-coach` and deploy the starter code.
3. Click **Edit code**, delete everything, paste in all of `worker.js`, and deploy.
4. Open the Worker's **Settings → Variables and Secrets** and add:

   | Name | Type | Value |
   | --- | --- | --- |
   | `ANTHROPIC_API_KEY` | Secret | the key from step 1 |
   | `ALLOWED_ORIGIN` | Text | `https://YOUR-USERNAME.github.io` (no slash or folder at the end) |

5. Copy the Worker's URL. It looks like `https://lights-out-coach.YOUR-NAME.workers.dev`.

`ALLOWED_ORIGIN` makes the server refuse requests from any other website, so nobody else can use your key.

## 4. Connect the website to the server

1. In GitHub, open `index.html` and click the pencil icon to edit.
2. Find this line (search for `COACH_URL`):

   ```js
   const COACH_URL=''; // e.g. 'https://lights-out-coach.yourname.workers.dev'
   ```

3. Paste your Worker URL between the quotes:

   ```js
   const COACH_URL='https://lights-out-coach.YOUR-NAME.workers.dev';
   ```

4. Commit the change. GitHub Pages updates in a minute or two.

## 5. Test it

1. Open your GitHub Pages site and go to **Insights**.
2. Press **Get my recommendations**. Three cards should appear within about 10 seconds.

If something goes wrong, the coach shows a message:

| Message | Fix |
| --- | --- |
| "isn't set up on this site yet" | `COACH_URL` is still empty in `index.html`. |
| "This website isn't allowed to use the coach." | `ALLOWED_ORIGIN` doesn't exactly match your site address. Check `https` and remove any trailing `/`. |
| "The server is missing its API key." | Add `ANTHROPIC_API_KEY` as a Secret, then redeploy. |
| "The coach couldn't answer right now." | Open the Worker's **Logs** in Cloudflare. A "model" error means the model name changed: add a Text variable `MODEL` with a current Haiku model ID from https://platform.claude.com/docs/en/about-claude/models/overview. A 401 error means the key is wrong. |
| "Couldn't reach the coach." | The Worker URL has a typo, or you're offline. |
| "Too many requests." | Each visitor gets 10 requests per hour. Wait, or raise `MAX_REQUESTS_PER_HOUR` in `worker.js`. |

## Talking points for judges

- **Why a server?** API keys must stay secret. Code in a web page is public, so the key lives on the server.
- **Security:** the server only accepts your website's address, limits requests per visitor, checks and trims every field it receives, and builds the prompt itself so nobody can use it as a free general-purpose AI.
- **Privacy:** only the last 14 check-ins are sent, never personal notes, and nothing is stored on the server.
- **Safety:** safety rules are added on the server to every request, even if someone edits the coach's instructions.
