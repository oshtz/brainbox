use std::fs;
use std::path::Path;
use std::sync::{Arc, Mutex};
use tantivy::collector::TopDocs;
use tantivy::query::QueryParser;
use tantivy::schema::{Schema, Field, TEXT, STORED, Value};
use tantivy::{IndexReader, ReloadPolicy, TantivyDocument};
use tantivy::doc;

#[cfg(target_os = "macos")]
use std::time::Duration;
#[cfg(target_os = "macos")]
use std::thread;

use serde::{Serialize, Deserialize};

// Search result item
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct SearchResult {
    pub id: String,
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
    schema: Schema,
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
        
        eprintln!("brainbox: Creating index directory if needed...");
        
        // Create index directory if it doesn't exist
        if !index_path.exists() {
            fs::create_dir_all(index_path)?;
        }
        
        // Create or open the index with macOS-specific timeout protection
        let index = {
            #[cfg(target_os = "macos")]
            {
                eprintln!("brainbox: Opening/creating search index with timeout protection (macOS)...");
                Self::create_index_with_timeout(index_path, schema.clone())?
            }
            
            #[cfg(not(target_os = "macos"))]
            {
                eprintln!("brainbox: Opening/creating search index...");
                tantivy::Index::open_or_create(tantivy::directory::MmapDirectory::open(index_path)?, schema.clone())?
            }
        };
        
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
        let reader = index.reader_builder()
            .reload_policy(ReloadPolicy::Manual)
            .try_into()?;

        eprintln!("brainbox: Search service created successfully");

        Ok(SearchService {
            index,
            reader,
            fields,
            schema,
        })
    }

    // Helper method to create index with timeout protection and fallback (macOS-specific)
    #[cfg(target_os = "macos")]
    fn create_index_with_timeout(index_path: &Path, schema: Schema) -> Result<tantivy::Index, tantivy::TantivyError> {
        use std::sync::mpsc;
        
        let (tx, rx) = mpsc::channel();
        let index_path = index_path.to_path_buf();
        let schema_clone = schema.clone();
        
        // Spawn a thread to create the index
        thread::spawn(move || {
            // First, try with MmapDirectory
            let result = match tantivy::directory::MmapDirectory::open(&index_path) {
                Ok(dir) => {
                    tantivy::Index::open_or_create(dir, schema_clone)
                },
                Err(e) => {
                    eprintln!("brainbox: Failed to open MmapDirectory: {}", e);
                    Err(tantivy::TantivyError::from(e))
                }
            };
            let _ = tx.send(result);
        });
        
        // Wait for result with timeout
        match rx.recv_timeout(Duration::from_secs(10)) {
            Ok(Ok(index)) => {
                eprintln!("brainbox: Successfully created index with MmapDirectory");
                Ok(index)
            },
            Ok(Err(e)) => {
                eprintln!("brainbox: MmapDirectory failed: {}", e);
                Self::create_fallback_index(schema)
            },
            Err(_) => {
                eprintln!("brainbox: Index creation timed out after 10 seconds, trying fallback...");
                Self::create_fallback_index(schema)
            }
        }
    }
    
    // Fallback to RAMDirectory when MmapDirectory fails (macOS-specific)
    #[cfg(target_os = "macos")]
    fn create_fallback_index(schema: Schema) -> Result<tantivy::Index, tantivy::TantivyError> {
        eprintln!("brainbox: Falling back to RAMDirectory (search index will not persist between sessions)");
        Ok(tantivy::Index::create_in_ram(schema))
    }
    
    // Method to attempt index recovery by clearing corrupted data
    pub fn recover_index(index_path: &Path) -> Result<(), std::io::Error> {
        eprintln!("brainbox: Attempting to recover search index by clearing corrupted data...");
        
        if index_path.exists() {
            // Remove the entire index directory
            std::fs::remove_dir_all(index_path)?;
            eprintln!("brainbox: Removed corrupted index directory");
        }
        
        // Recreate the directory
        std::fs::create_dir_all(index_path)?;
        eprintln!("brainbox: Recreated index directory");
        
        Ok(())
    }

    // Add or update a document in the index
    pub fn index_document(&self, 
        id: &str, 
        title: &str, 
        content: &str, 
        item_type: &str,
        created_at: &str,
        updated_at: &str,
        path: Option<&str>,
        tags: &[&str]
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
    pub fn search(&self, query_str: &str, limit: usize) -> Result<Vec<SearchResult>, tantivy::TantivyError> {
        // Best-effort reload so searches see newly committed docs
        let _ = self.reader.reload();
        let searcher = self.reader.searcher();
        
        // Create query parser with appropriate fields
        let mut query_parser = QueryParser::for_index(&self.index, vec![self.fields.title, self.fields.content, self.fields.tags]);
        
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
                
            let tags: Vec<String> = retrieved_doc
                .get_all(self.fields.tags)
                .filter_map(|f| f.as_str().map(|s| s.to_string()))
                .collect();

            // Create preview text (simulated since we don't store content)
            let content_preview = format!("Matched with score: {:.3}", score);
                
            let result = SearchResult {
                id,
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
pub fn get_search_service() -> Option<Arc<SearchService>> {
    let service_ref = SEARCH_SERVICE.lock().unwrap();
    if let Some(service) = &*service_ref {
        Some(Arc::new(service.clone()))
    } else {
        None
    }
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
            service.index_document(
                &id,
                &title,
                &content,
                &item_type,
                &created_at,
                &updated_at,
                path.as_deref(),
                &tags_refs,
            ).map_err(|e| e.to_string())
        },
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
