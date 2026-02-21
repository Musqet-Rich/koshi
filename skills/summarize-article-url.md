---
name: summarize-article-url
description: Fetch and summarize a web article from a given URL
triggers: [summarize, summary, article, url, link, read article, tldr, "sum up", webpage]
tools: [WebFetch]
---

## How to summarize an article

1. Use `WebFetch` to retrieve the content at the given URL
   - Use a prompt like: "Extract the full article text, title, author, and publication date"
2. Produce a concise summary with:
   - **Title** and source
   - **Key points** (3-5 bullet points)
   - **Main takeaway** (1 sentence)
3. Keep the summary brief — aim for ~150 words unless the user asks for more detail
4. If the URL is inaccessible or returns an error, let the user know and suggest alternatives

## Common patterns
- "Summarize this article: <url>" -> fetch and summarize
- "What does this link say?" -> fetch and summarize
- "TLDR of <url>" -> fetch and produce a very short summary (3 sentences max)
