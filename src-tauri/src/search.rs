use std::fs;
use std::path::Path;
use std::sync::{Arc, Mutex};
use tantivy::collector::TopDocs;
use tantivy::doc;
use tantivy::query::QueryParser;
use tantivy::schema::{Field, Schema, Value, STORED, TEXT};
use tantivy::{IndexReader, ReloadPolicy, TantivyDocument};

use serde::{Deserialize, Serialize};

// Search result item
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct SearchResult {
    pub id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub vault_id: Option<i64>,
    pub title: String,
    pub content_preview: String,
    pub score: f32,
    pub metadata: SearchResultMetadata,
}

// Additional metadata for search results
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct SearchResultMetadata {
    pub item_type: String,
    pub created_at: String,
    pub updated_at: String,
    pub path: Option<String>,
    pub tags: Vec<String>,
}

fn vault_id_from_path(path: Option<&str>) -> Option<i64> {
    let path = path?;
    let mut segments = path.split('/');
    match (segments.next(), segments.next()) {
        (Some("vault"), Some(id)) => id.parse::<i64>().ok(),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_vault_id_from_index_path() {
        assert_eq!(vault_id_from_path(Some("vault/42/item/7")), Some(42));
        assert_eq!(vault_id_from_path(Some("vault/not-a-number/item/7")), None);
        assert_eq!(vault_id_from_path(Some("capture/42")), None);
        assert_eq!(vault_id_from_path(None), None);
    }

    #[test]
    fn search_results_include_vault_id_from_path() {
        let index_path =
            std::env::temp_dir().join(format!("brainbox-search-test-{}", uuid::Uuid::new_v4()));

        {
            let service =
                SearchService::new(&index_path).expect("search service should initialize");
            service
                .index_document(
                    "vault-42-item-7",
                    "Alpha note",
                    "alpha content",
                    "vault_item",
                    "2026-06-02T00:00:00Z",
                    "2026-06-02T00:00:00Z",
                    Some("vault/42/item/7"),
                    &["alpha"],
                )
                .expect("document should index");

            let results = service.search("alpha", 10).expect("search should run");
            let result = results
                .iter()
                .find(|result| result.id == "vault-42-item-7")
                .expect("indexed document should be returned");

            assert_eq!(result.vault_id, Some(42));
            assert_eq!(result.metadata.path.as_deref(), Some("vault/42/item/7"));
            assert!(
                !index_path.exists(),
                "decrypted search tokens must not be persisted"
            );
        }
    }
}

// Fields for the search schema
#[derive(Debug, Clone)]
pub struct SearchFields {
    pub id: Field,
    pub title: Field,
    pub content: Field,
    pub item_type: Field,
    pub created_at: Field,
    pub updated_at: Field,
    pub path: Field,
    pub tags: Field,
}

// Search service for managing the Tantivy index
#[derive(Clone)]
pub struct SearchService {
    index: tantivy::Index,
    reader: IndexReader,
    fields: SearchFields,
}

impl SearchService {
    // Create a new search service with a BM25 configuration
    pub fn new(index_path: &Path) -> Result<Self, tantivy::TantivyError> {
        eprintln!("brainbox: Creating search schema...");

        // Create the schema
        let mut schema_builder = Schema::builder();

        // Define the schema fields
        let id = schema_builder.add_text_field("id", TEXT | STORED);
        let title = schema_builder.add_text_field("title", TEXT | STORED);
        let content = schema_builder.add_text_field("content", TEXT);
        let item_type = schema_builder.add_text_field("item_type", TEXT | STORED);
        let created_at = schema_builder.add_text_field("created_at", TEXT | STORED);
        let updated_at = schema_builder.add_text_field("updated_at", TEXT | STORED);
        let path = schema_builder.add_text_field("path", TEXT | STORED);
        let tags = schema_builder.add_text_field("tags", TEXT | STORED);

        let schema = schema_builder.build();

        // Decrypted content must never be persisted. Remove legacy plaintext indexes and
        // keep the replacement index in memory for the current process only.
        if index_path.exists() {
            fs::remove_dir_all(index_path)?;
        }
        let index = tantivy::Index::create_in_ram(schema);

        // Create the fields structure for easy access
        let fields = SearchFields {
            id,
            title,
            content,
            item_type,
            created_at,
            updated_at,
            path,
            tags,
        };

        eprintln!("brainbox: Initializing index writer...");

        // Initialize the index writer
        let mut index_writer: tantivy::IndexWriter = index.writer(50_000_000)?; // 50MB buffer

        // BM25 is used by default in Tantivy 0.22, no need to explicitly set it

        index_writer.commit()?;

        eprintln!("brainbox: Creating index reader...");

        // Create the reader (manual reload; we call reload() after commits)
        let reader = index
            .reader_builder()
            .reload_policy(ReloadPolicy::Manual)
            .try_into()?;

        eprintln!("brainbox: Search service created successfully");

        Ok(SearchService {
            index,
            reader,
            fields,
        })
    }

    // Method to attempt index recovery by clearing corrupted data
    #[allow(dead_code)]
    pub fn recover_index(index_path: &Path) -> Result<(), std::io::Error> {
        eprintln!("brainbox: Attempting to recover search index by clearing corrupted data...");

        if index_path.exists() {
            // Remove the entire index directory
            std::fs::remove_dir_all(index_path)?;
            eprintln!("brainbox: Removed corrupted index directory");
        }

        Ok(())
    }

    // Add or update a document in the index
    #[allow(clippy::too_many_arguments)] // Stable Tauri command/document schema boundary.
    pub fn index_document(
        &self,
        id: &str,
        title: &str,
        content: &str,
        item_type: &str,
        created_at: &str,
        updated_at: &str,
        path: Option<&str>,
        tags: &[&str],
    ) -> Result<(), tantivy::TantivyError> {
        // Create a new document using the doc! macro
        let mut doc = doc!(
            self.fields.id => id,
            self.fields.title => title,
            self.fields.content => content,
            self.fields.item_type => item_type,
            self.fields.created_at => created_at,
            self.fields.updated_at => updated_at
        );

        if let Some(p) = path {
            doc.add_text(self.fields.path, p);
        }

        for tag in tags {
            doc.add_text(self.fields.tags, tag);
        }

        let mut index_writer: tantivy::IndexWriter = self.index.writer(50_000_000)?;

        // Delete existing document with same ID if exists
        let term = tantivy::Term::from_field_text(self.fields.id, id);
        index_writer.delete_term(term);

        // Add the new document
        index_writer.add_document(doc)?;
        index_writer.commit()?;
        // Ensure the reader sees the latest commit
        let _ = self.reader.reload();

        Ok(())
    }

    // Delete a document from the index
    pub fn delete_document(&self, id: &str) -> Result<(), tantivy::TantivyError> {
        let mut index_writer: tantivy::IndexWriter = self.index.writer(50_000_000)?;
        let term = tantivy::Term::from_field_text(self.fields.id, id);
        index_writer.delete_term(term);
        index_writer.commit()?;
        let _ = self.reader.reload();
        Ok(())
    }

    // Search documents using BM25 ranking
    pub fn search(
        &self,
        query_str: &str,
        limit: usize,
    ) -> Result<Vec<SearchResult>, tantivy::TantivyError> {
        // Best-effort reload so searches see newly committed docs
        let _ = self.reader.reload();
        let searcher = self.reader.searcher();

        // Create query parser with appropriate fields
        let mut query_parser = QueryParser::for_index(
            &self.index,
            vec![self.fields.title, self.fields.content, self.fields.tags],
        );

        // Set field boosts
        query_parser.set_field_boost(self.fields.title, 2.0);
        query_parser.set_field_boost(self.fields.content, 1.0);
        query_parser.set_field_boost(self.fields.tags, 1.5);

        // Parse query and search
        let query = query_parser.parse_query(query_str)?;
        let top_docs = searcher.search(&query, &TopDocs::with_limit(limit))?;

        // Process results
        let mut results = Vec::with_capacity(top_docs.len());
        for (score, doc_address) in top_docs {
            // Retrieve the actual document content using the DocAddress
            let retrieved_doc = searcher.doc::<TantivyDocument>(doc_address)?;

            // Convert TantivyDocument to your application's Document struct
            let id = retrieved_doc
                .get_first(self.fields.id)
                .and_then(|f| f.as_str())
                .unwrap_or_default()
                .to_string();

            let title = retrieved_doc
                .get_first(self.fields.title)
                .and_then(|f| f.as_str())
                .unwrap_or_default()
                .to_string();

            let item_type = retrieved_doc
                .get_first(self.fields.item_type)
                .and_then(|f| f.as_str())
                .unwrap_or_default()
                .to_string();

            let created_at = retrieved_doc
                .get_first(self.fields.created_at)
                .and_then(|f| f.as_str())
                .unwrap_or_default()
                .to_string();

            let updated_at = retrieved_doc
                .get_first(self.fields.updated_at)
                .and_then(|f| f.as_str())
                .unwrap_or_default()
                .to_string();

            let path = retrieved_doc
                .get_first(self.fields.path)
                .and_then(|f| f.as_str())
                .map(|s| s.to_string());

            let vault_id = vault_id_from_path(path.as_deref());

            let tags: Vec<String> = retrieved_doc
                .get_all(self.fields.tags)
                .filter_map(|f| f.as_str().map(|s| s.to_string()))
                .collect();

            // Create preview text (simulated since we don't store content)
            let content_preview = format!("Matched with score: {:.3}", score);

            let result = SearchResult {
                id,
                vault_id,
                title,
                content_preview,
                score,
                metadata: SearchResultMetadata {
                    item_type,
                    created_at,
                    updated_at,
                    path,
                    tags,
                },
            };

            results.push(result);
        }

        Ok(results)
    }
}

// Singleton instance of the search service
lazy_static::lazy_static! {
    static ref SEARCH_SERVICE: Arc<Mutex<Option<SearchService>>> = Arc::new(Mutex::new(None));
}

// Initialize the search service
pub fn init_search_service(index_path: &Path) -> Result<(), tantivy::TantivyError> {
    let service = SearchService::new(index_path)?;
    let mut service_ref = SEARCH_SERVICE.lock().unwrap();
    *service_ref = Some(service);
    Ok(())
}

// Get a reference to the search service
#[allow(dead_code)]
pub fn get_search_service() -> Option<Arc<SearchService>> {
    let service_ref = SEARCH_SERVICE.lock().unwrap();
    (*service_ref)
        .as_ref()
        .map(|service| Arc::new(service.clone()))
}

// Tauri command for searching
#[tauri::command]
pub fn search(query: String, limit: usize) -> Result<Vec<SearchResult>, String> {
    let service_ref = SEARCH_SERVICE.lock().unwrap();
    match &*service_ref {
        Some(service) => service.search(&query, limit).map_err(|e| e.to_string()),
        None => Err("Search service not initialized".to_string()),
    }
}

// Tauri command to index a document
#[tauri::command]
#[allow(clippy::too_many_arguments)] // Arguments are the public renderer IPC contract.
pub fn index_document(
    id: String,
    title: String,
    content: String,
    item_type: String,
    created_at: String,
    updated_at: String,
    path: Option<String>,
    tags: Vec<String>,
) -> Result<(), String> {
    let service_ref = SEARCH_SERVICE.lock().unwrap();
    match &*service_ref {
        Some(service) => {
            let tags_refs: Vec<&str> = tags.iter().map(|s| s.as_str()).collect();
            service
                .index_document(
                    &id,
                    &title,
                    &content,
                    &item_type,
                    &created_at,
                    &updated_at,
                    path.as_deref(),
                    &tags_refs,
                )
                .map_err(|e| e.to_string())
        }
        None => Err("Search service not initialized".to_string()),
    }
}

// Tauri command to delete a document
#[tauri::command]
pub fn delete_document(id: String) -> Result<(), String> {
    let service_ref = SEARCH_SERVICE.lock().unwrap();
    match &*service_ref {
        Some(service) => service.delete_document(&id).map_err(|e| e.to_string()),
        None => Err("Search service not initialized".to_string()),
    }
}
