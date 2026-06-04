use tauri::Emitter;

#[derive(serde::Serialize)]
pub struct UrlMetadata {
    final_url: String,
    title: Option<String>,
    description: Option<String>,
    image: Option<String>,
    site_name: Option<String>,
    favicon: Option<String>,
}

#[tauri::command]
pub fn fetch_url_metadata(url: String) -> Result<UrlMetadata, String> {
    use regex::Regex;
    use reqwest::blocking::Client;
    use reqwest::header::{ACCEPT, ACCEPT_LANGUAGE, USER_AGENT};

    let client = Client::builder()
        .redirect(reqwest::redirect::Policy::limited(10))
        .build()
        .map_err(|e| e.to_string())?;

    let resp = client
        .get(&url)
        .header(USER_AGENT, "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36")
        .header(ACCEPT, "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8")
        .header(ACCEPT_LANGUAGE, "en-US,en;q=0.9")
        .send()
        .map_err(|e| e.to_string())?;

    let final_url = resp.url().to_string();
    let text = resp.text().map_err(|e| e.to_string())?;

    // Simple regex-based extraction to avoid heavy dependencies
    let re_meta = |name: &str| -> Regex {
        Regex::new(&format!(
            r#"<meta[^>]+(?:property|name)=[\"']{}[\"'][^>]*content=[\"']([^\"']+)[\"'][^>]*>"#,
            regex::escape(name)
        ))
        .unwrap()
    };
    let re_title = Regex::new(r#"<title[^>]*>([^<]+)</title>"#).unwrap();
    let get = |re: &Regex| {
        re.captures(&text)
            .and_then(|c| c.get(1).map(|m| m.as_str().to_string()))
    };

    let og_title = get(&re_meta("og:title"));
    let og_desc = get(&re_meta("og:description"));
    let og_image = get(&re_meta("og:image")).or(get(&re_meta("og:image:secure_url")));
    let tw_image = get(&re_meta("twitter:image")).or(get(&re_meta("twitter:image:src")));
    let site_name = get(&re_meta("og:site_name"));
    let title_fallback = re_title
        .captures(&text)
        .and_then(|c| c.get(1).map(|m| m.as_str().to_string()));

    // Build favicon via Google S2 as a robust default
    let favicon = (|| {
        let host = reqwest::Url::parse(&final_url)
            .ok()?
            .host_str()?
            .to_string();
        Some(format!(
            "https://www.google.com/s2/favicons?sz=64&domain={}",
            host
        ))
    })();

    // Prefer og:image, fall back to twitter:image, and resolve relative URLs
    let image = (|| {
        let img = og_image.or(tw_image)?;
        if let Ok(base) = reqwest::Url::parse(&final_url) {
            if let Ok(joined) = base.join(&img) {
                return Some(joined.to_string());
            }
        }
        Some(img)
    })();

    Ok(UrlMetadata {
        final_url,
        title: og_title.or(title_fallback),
        description: og_desc,
        image,
        site_name,
        favicon,
    })
}

// Extract readable text from a web page (best-effort)
#[tauri::command]
pub fn fetch_url_text(url: String) -> Result<String, String> {
    use reqwest::blocking::Client;
    let client = Client::builder()
        .redirect(reqwest::redirect::Policy::limited(10))
        .build()
        .map_err(|e| e.to_string())?;
    let resp = client.get(&url).send().map_err(|e| e.to_string())?;
    let html = resp.text().map_err(|e| e.to_string())?;
    let document = scraper::Html::parse_document(&html);
    let selector = scraper::Selector::parse("body").unwrap();
    let mut out = String::new();
    for el in document.select(&selector) {
        for txt in el.text() {
            let t = txt.trim();
            if !t.is_empty() {
                out.push_str(t);
                out.push('\n');
            }
        }
    }
    Ok(out)
}

// Fetch YouTube transcript if available by scraping captionTracks
#[tauri::command]
pub fn fetch_youtube_transcript(url: String) -> Result<Option<String>, String> {
    use regex::Regex;
    use reqwest::blocking::Client;
    let u = match reqwest::Url::parse(&url) {
        Ok(u) => u,
        Err(_) => return Ok(None),
    };
    let host = u.host_str().unwrap_or("");
    if !host.contains("youtube.com") && !host.contains("youtu.be") {
        return Ok(None);
    }

    let client = Client::builder()
        .redirect(reqwest::redirect::Policy::limited(10))
        .build()
        .map_err(|e| e.to_string())?;
    let resp = client.get(u.clone()).send().map_err(|e| e.to_string())?;
    let page = resp.text().map_err(|e| e.to_string())?;
    // Find captionTracks JSON array
    let re = Regex::new(r#""captionTracks"\s*:\s*(\[[^\]]+\])"#).map_err(|e| e.to_string())?;
    let caps = match re.captures(&page) {
        Some(c) => c,
        None => return Ok(None),
    };
    let tracks_json = caps.get(1).map(|m| m.as_str()).unwrap_or("");
    let val: serde_json::Value = match serde_json::from_str(tracks_json) {
        Ok(v) => v,
        Err(_) => return Ok(None),
    };
    let base = match val
        .get(0)
        .and_then(|t| t.get("baseUrl"))
        .and_then(|v| v.as_str())
    {
        Some(s) => s,
        None => return Ok(None),
    };
    let base_url = base.replace("\\u0026", "&");
    let tr_resp = client.get(&base_url).send().map_err(|e| e.to_string())?;
    let xml = tr_resp.text().map_err(|e| e.to_string())?;
    // Parse XML transcript: collect <text> nodes
    let mut reader = quick_xml::Reader::from_str(&xml);
    reader.trim_text(true);
    let mut buf = Vec::new();
    let mut acc = String::new();
    loop {
        use quick_xml::events::Event;
        match reader.read_event_into(&mut buf) {
            Ok(Event::Eof) => break,
            Ok(Event::Text(t)) => {
                let txt = t.unescape().unwrap_or_default().to_string();
                if !txt.trim().is_empty() {
                    acc.push_str(&txt);
                    acc.push('\n');
                }
            }
            Ok(_) => {}
            Err(_) => break,
        }
        buf.clear();
    }
    if acc.trim().is_empty() {
        Ok(None)
    } else {
        Ok(Some(acc))
    }
}

// --- Ollama Integration ---
#[derive(serde::Deserialize)]
struct OllamaTagsResponse {
    models: Vec<OllamaModelInfo>,
}

#[derive(serde::Deserialize)]
struct OllamaModelInfo {
    name: String,
}

fn sanitize_base_url(input: Option<String>) -> String {
    let default_url = "http://127.0.0.1:11434".to_string();
    let raw = input.unwrap_or(default_url);
    let trimmed = raw.trim().trim_end_matches('/').to_string();
    if trimmed.is_empty() {
        "http://127.0.0.1:11434".to_string()
    } else {
        trimmed
    }
}

#[tauri::command]
pub fn ollama_list_models(base_url: Option<String>) -> Result<Vec<String>, String> {
    use reqwest::blocking::Client;
    let base = sanitize_base_url(base_url);
    let url = format!("{}/api/tags", base);
    let client = Client::builder()
        .timeout(std::time::Duration::from_secs(8))
        .build()
        .map_err(|e| e.to_string())?;
    let resp = client.get(&url).send().map_err(|e| e.to_string())?;
    if !resp.status().is_success() {
        return Err(format!("Ollama returned status {}", resp.status()));
    }
    let tags: OllamaTagsResponse = resp.json().map_err(|e| e.to_string())?;
    Ok(tags.models.into_iter().map(|m| m.name).collect())
}

#[derive(serde::Serialize)]
struct OllamaGenerateRequest<'a> {
    model: &'a str,
    prompt: &'a str,
    stream: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    system: Option<&'a str>,
}

#[derive(serde::Deserialize)]
struct OllamaGenerateResponse {
    response: String,
}

#[tauri::command]
pub fn ollama_generate(
    model: String,
    prompt: String,
    base_url: Option<String>,
    system: Option<String>,
) -> Result<String, String> {
    use reqwest::blocking::Client;
    let base = sanitize_base_url(base_url);
    let url = format!("{}/api/generate", base);
    let body = OllamaGenerateRequest {
        model: &model,
        prompt: &prompt,
        stream: false,
        system: system.as_deref(),
    };
    let client = Client::builder()
        .timeout(std::time::Duration::from_secs(60))
        .build()
        .map_err(|e| e.to_string())?;
    let resp = client
        .post(&url)
        .json(&body)
        .send()
        .map_err(|e| e.to_string())?;
    if !resp.status().is_success() {
        return Err(format!("Ollama returned status {}", resp.status()));
    }
    let gen: OllamaGenerateResponse = resp.json().map_err(|e| e.to_string())?;
    Ok(gen.response)
}

#[derive(serde::Serialize, Clone)]
struct StreamEvent {
    #[serde(rename = "streamId")]
    stream_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    delta: Option<String>,
    done: bool,
}

// Stream generate via events: emits "ollama-stream" with {streamId, delta} and a final {done:true}
#[tauri::command]
pub fn ollama_generate_stream(
    app: tauri::AppHandle,
    model: String,
    prompt: String,
    base_url: Option<String>,
    system: Option<String>,
    stream_id: String,
) -> Result<(), String> {
    use reqwest::blocking::Client;
    use std::io::{BufRead, BufReader};
    let base = sanitize_base_url(base_url);
    let url = format!("{}/api/generate", base);
    let body = OllamaGenerateRequest {
        model: &model,
        prompt: &prompt,
        stream: true,
        system: system.as_deref(),
    };
    let client = Client::builder().build().map_err(|e| e.to_string())?;
    let resp = client
        .post(&url)
        .json(&body)
        .send()
        .map_err(|e| e.to_string())?;
    if !resp.status().is_success() {
        return Err(format!("Ollama returned status {}", resp.status()));
    }
    let mut reader = BufReader::new(resp);
    let mut line = String::new();
    loop {
        line.clear();
        let n = reader.read_line(&mut line).map_err(|e| e.to_string())?;
        if n == 0 {
            break;
        }
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        if let Ok(v) = serde_json::from_str::<serde_json::Value>(trimmed) {
            if v.get("done").and_then(|d| d.as_bool()).unwrap_or(false) {
                let _ = app.emit(
                    "ollama-stream",
                    StreamEvent {
                        stream_id: stream_id.clone(),
                        delta: None,
                        done: true,
                    },
                );
                break;
            }
            if let Some(delta) = v.get("response").and_then(|s| s.as_str()) {
                let _ = app.emit(
                    "ollama-stream",
                    StreamEvent {
                        stream_id: stream_id.clone(),
                        delta: Some(delta.to_string()),
                        done: false,
                    },
                );
            }
        }
    }
    Ok(())
}
