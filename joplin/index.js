import dotenv from 'dotenv';
import { exec } from 'child_process';
import { promisify } from 'util';
import { writeFileSync, unlinkSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

dotenv.config();

const execAsync = promisify(exec);

/** Default notebook for WhatsApp-created notes (agent should only touch this notebook). */
export const WHATSAPP_BOT_NOTEBOOK = 'WhatsApp Bot';

function idsMatch(listId, queryId) {
    const a = listId.toLowerCase();
    const b = queryId.toLowerCase();
    return a === b || a.startsWith(b) || b.startsWith(a);
}

// Environment variables for Joplin Server
const JOPLIN_SERVER_URL = process.env.JOPLIN_SERVER_URL
const JOPLIN_EMAIL = process.env.JOPLIN_EMAIL
const JOPLIN_PASSWORD = process.env.JOPLIN_PASSWORD

/** Minimum milliseconds between automatic sync-before-read calls. */
const SYNC_THROTTLE_MS = 30_000;

class JoplinAPI {
    constructor() {
        this.serverUrl = JOPLIN_SERVER_URL;
        this.email = JOPLIN_EMAIL;
        this.password = JOPLIN_PASSWORD;
        this.sessionId = null;
        this._lastSyncTime = 0;
    }

    /**
     * Pull remote changes so local queries see freshly-created / modified notes.
     * Throttled: skips if the last sync was less than SYNC_THROTTLE_MS ago.
     */
    async syncIfNeeded() {
        const now = Date.now();
        if (now - this._lastSyncTime < SYNC_THROTTLE_MS) return;
        try {
            await execAsync('joplin sync');
            this._lastSyncTime = Date.now();
        } catch (err) {
            console.warn('⚠️ Pre-read sync failed (non-fatal):', err.message);
        }
    }

    /** Mark that a sync just happened (called after write-path syncs). */
    _markSynced() {
        this._lastSyncTime = Date.now();
    }

    async configureCli() {
        try {
            if (this.configured) {
                return true;
            }

            // Check if already configured by testing sync
            try {
                const { stdout } = await execAsync('joplin config sync.target');
                if (stdout.includes('9')) {
                    console.log('✅ Joplin CLI already configured');
                    this.configured = true;
                    return true;
                }
            } catch (error) {
                // If config check fails, proceed with configuration
            }

            console.log('🔧 Configuring Joplin CLI...');
            
            // Configure sync target
            await execAsync('joplin config sync.target 9');
            
            // Configure server path
            await execAsync(`joplin config sync.9.path "${this.serverUrl}"`);
            
            // Configure username
            await execAsync(`joplin config sync.9.username "${this.email}"`);
            
            // Configure password
            await execAsync(`joplin config sync.9.password "${this.password}"`);
            
            this.configured = true;
            console.log('✅ Joplin CLI configured successfully');
            return true;
        } catch (error) {
            console.error('❌ Failed to configure Joplin CLI:', error.message);
            return false;
        }
    }

    async ensureWhatsAppNotebook() {
        try {
            // Check if WhatsApp Bot notebook exists
            const { stdout } = await execAsync('joplin ls /');
            if (stdout.includes('WhatsApp Bot')) {
                return true; // Notebook already exists
            }

            // Create WhatsApp Bot notebook
            console.log('📁 Creating WhatsApp Bot notebook...');
            await execAsync('joplin mkbook "WhatsApp Bot"');
            console.log('✅ WhatsApp Bot notebook created');
            return true;
        } catch (error) {
            console.error('❌ Failed to create WhatsApp Bot notebook:', error.message);
            return false;
        }
    }

    async checkConnection() {
        try {
            // First ensure CLI is configured
            const configSuccess = await this.configureCli();
            if (!configSuccess) {
                return false;
            }
            
            // Test Joplin CLI connection
            const { stdout, stderr } = await execAsync('joplin version');
            
            if (stderr) {
                console.warn('Joplin CLI warning:', stderr);
            }
            
            console.log('✅ Joplin CLI connection successful');
            return true;
        } catch (error) {
            console.error('❌ Joplin CLI connection failed:', error.message);
            return false;
        }
    }

    async createNote(title, body, parentId = null) {
        try {
            // Ensure CLI is configured
            await this.configureCli();
            
            // Ensure WhatsApp Bot notebook exists
            await this.ensureWhatsAppNotebook();
            
            // Escape the title for shell command
            const escapedTitle = title.replace(/'/g, "'\"'\"'");
            
            // Create a temporary file with the full note content (title + body)
            const tempFile = join(tmpdir(), `joplin_note_${Date.now()}_${Math.random().toString(36).substr(2, 9)}.md`);
            const noteContent = body && body.trim() ? `${title}\n\n${body}` : title;
            let noteId = null;
            
            try {
                writeFileSync(tempFile, noteContent, 'utf8');
                
                // Use the file to create the note
                let command = `joplin mknote "$(cat "${tempFile}")"`;
                
                // Use WhatsApp Bot notebook if no parent specified
                if (parentId) {
                    command += ` "${parentId}"`;
                } else {
                    command += ` "WhatsApp Bot"`;
                }
            
                console.log('Creating note with Joplin CLI...');
                const { stdout, stderr } = await execAsync(command);
                
                if (stderr) {
                    console.warn('Joplin CLI warning:', stderr);
                }
                
                // Find the note ID by searching for the title
                const { stdout: listOutput } = await execAsync('joplin ls -l');
                const lines = listOutput.split('\n').filter(line => line.trim());
                
                for (const line of lines) {
                    if (line.includes(title)) {
                        const match = line.match(/^([a-f0-9]+)\s+/);
                        if (match) {
                            noteId = match[1];
                            break;
                        }
                    }
                }
                
                if (!noteId) {
                    throw new Error('Could not find created note ID');
                }
                
                // Set markup language to markdown
                await execAsync(`joplin set "${noteId}" markup_language 1`);
                
            } finally {
                // Clean up the temporary file
                try {
                    unlinkSync(tempFile);
                } catch (cleanupError) {
                    console.warn('Could not delete temp file:', cleanupError.message);
                }
            }
            
            // Sync to ensure the note is uploaded to the server
            await execAsync('joplin sync');
            this._markSynced();
            
            console.log('✅ Note created successfully:', noteId);
            
            return { 
                id: noteId, 
                title, 
                body
            };
        } catch (error) {
            console.error('❌ Failed to create note:', error.message);
            throw error;
        }
    }

    async getNotebooks() {
        try {
            // Ensure CLI is configured
            await this.configureCli();
            await this.syncIfNeeded();
            
            const { stdout, stderr } = await execAsync('joplin ls /');
            
            if (stderr) {
                console.warn('Joplin CLI warning:', stderr);
            }
            
            // Parse the output to extract notebook information
            const lines = stdout.split('\n').filter(line => line.trim());
            const notebooks = [];
            
            for (const line of lines) {
                // For ls /, each line is just the notebook name
                if (line.trim()) {
                    notebooks.push({
                        id: line.trim(), // Use name as ID for now
                        title: line.trim()
                    });
                }
            }
            
            return notebooks;
        } catch (error) {
            console.error('❌ Failed to get notebooks:', error.message);
            throw error;
        }
    }

    async searchNotes(query) {
        try {
            // Ensure CLI is configured
            await this.configureCli();
            await this.syncIfNeeded();
            
            // Get all notebooks first
            const { stdout: notebooksOutput } = await execAsync('joplin ls /');
            const notebooks = notebooksOutput.split('\n').filter(line => line.trim());
            
            const allNotes = [];
            
            // Search through each notebook
            for (const notebook of notebooks) {
                if (notebook.trim()) {
                    try {
                        // Switch to the notebook
                        await execAsync(`joplin use "${notebook.trim()}"`);
                        
                        // Get notes in this notebook
                        const { stdout, stderr } = await execAsync('joplin ls -l');
                        
                        if (stderr) {
                            console.warn('Joplin CLI warning:', stderr);
                        }
                        
                        // Parse the output and filter by query
                        const lines = stdout.split('\n').filter(line => line.trim());
                        
                        for (const line of lines) {
                            if (line.toLowerCase().includes(query.toLowerCase())) {
                                // Match format: ID DATE TIME TITLE
                                const match = line.match(/^([a-f0-9]+)\s+\d{2}\/\d{2}\/\d{4}\s+\d{2}:\d{2}\s+(.+)$/);
                                if (match) {
                                    allNotes.push({
                                        id: match[1],
                                        title: match[2].trim(),
                                        notebook: notebook.trim()
                                    });
                                } else {
                                    // Try alternative format without time
                                    const altMatch = line.match(/^([a-f0-9]+)\s+\d{2}\/\d{2}\/\d{4}\s+(.+)$/);
                                    if (altMatch) {
                                        allNotes.push({
                                            id: altMatch[1],
                                            title: altMatch[2].trim(),
                                            notebook: notebook.trim()
                                        });
                                    }
                                }
                            }
                        }
                    } catch (error) {
                        // Skip notebooks that can't be accessed
                        console.warn(`Warning: Could not search notebook "${notebook}":`, error.message);
                    }
                }
            }
            
            return allNotes;
        } catch (error) {
            console.error('❌ Failed to search notes:', error.message);
            throw error;
        }
    }

    /**
     * Search only inside one notebook (one `use` + `ls -l`). Use for agents to avoid scanning every notebook.
     */
    async searchNotesInNotebook(notebookName, query) {
        try {
            await this.configureCli();
            await this.syncIfNeeded();
            if (notebookName === WHATSAPP_BOT_NOTEBOOK) {
                await this.ensureWhatsAppNotebook();
            }
            await execAsync(`joplin use "${notebookName}"`);
            const { stdout, stderr } = await execAsync('joplin ls -l');
            if (stderr) {
                console.warn('Joplin CLI warning:', stderr);
            }
            const q = query.toLowerCase();
            const lines = stdout.split('\n').filter((line) => line.trim());
            const allNotes = [];
            for (const line of lines) {
                if (!line.toLowerCase().includes(q)) continue;
                let match = line.match(/^([a-f0-9]+)\s+\d{2}\/\d{2}\/\d{4}\s+\d{2}:\d{2}\s+(.+)$/);
                if (match) {
                    allNotes.push({
                        id: match[1],
                        title: match[2].trim(),
                        notebook: notebookName,
                    });
                    continue;
                }
                match = line.match(/^([a-f0-9]+)\s+\d{2}\/\d{2}\/\d{4}\s+(.+)$/);
                if (match) {
                    allNotes.push({
                        id: match[1],
                        title: match[2].trim(),
                        notebook: notebookName,
                    });
                }
            }
            return allNotes;
        } catch (error) {
            console.error('❌ Failed to search notes in notebook:', error.message);
            throw error;
        }
    }

    async resolveNoteIdInNotebook(noteId, notebookName) {
        await this.configureCli();
        await this.syncIfNeeded();
        if (notebookName === WHATSAPP_BOT_NOTEBOOK) {
            await this.ensureWhatsAppNotebook();
        }
        await execAsync(`joplin use "${notebookName}"`);
        const { stdout: listOutput } = await execAsync('joplin ls -l');
        const lines = listOutput.split('\n').filter((line) => line.trim());
        for (const line of lines) {
            const idMatch = line.match(/^([a-f0-9]+)/);
            if (!idMatch) continue;
            const lid = idMatch[1];
            if (idsMatch(lid, noteId)) {
                return lid;
            }
        }
        throw new Error(`Note "${noteId}" is not in notebook "${notebookName}"`);
    }

    /**
     * Read a note only if it lives in the given notebook (prevents cross-notebook reads by id).
     */
    async getNoteInNotebook(noteId, notebookName) {
        try {
            const resolvedId = await this.resolveNoteIdInNotebook(noteId, notebookName);
            const { stdout, stderr } = await execAsync(`joplin cat "${resolvedId}"`);
            if (stderr) {
                console.warn('Joplin CLI warning:', stderr);
            }
            const { stdout: listOutput } = await execAsync('joplin ls -l');
            const lines = listOutput.split('\n').filter((line) => line.trim());
            let title = '';
            for (const line of lines) {
                if (!line.startsWith(resolvedId)) continue;
                const match = line.match(/^([a-f0-9]+)\s+(\d{2}\/\d{2}\/\d{4})\s+(\d{2}:\d{2})\s+(.+)$/);
                if (match) {
                    title = match[4].trim();
                    break;
                }
            }
            return {
                id: resolvedId,
                title,
                body: stdout.trim(),
                created_time: null,
                updated_time: null,
            };
        } catch (error) {
            console.error('❌ Failed to get note from notebook:', error.message);
            throw error;
        }
    }

    /** Title list + count for a single notebook (cheap: one use + one ls). */
    async summarizeNotebook(notebookName) {
        await this.configureCli();
        await this.syncIfNeeded();
        if (notebookName === WHATSAPP_BOT_NOTEBOOK) {
            await this.ensureWhatsAppNotebook();
        }
        await execAsync(`joplin use "${notebookName}"`);
        const { stdout, stderr } = await execAsync('joplin ls -l');
        if (stderr) {
            console.warn('Joplin CLI warning:', stderr);
        }
        const lines = stdout.split('\n').filter((line) => line.trim());
        const notes = [];
        for (const line of lines) {
            const m = line.match(/^([a-f0-9]+)\s+\d{2}\/\d{2}\/\d{4}\s+\d{2}:\d{2}\s+(.+)$/);
            const m2 = line.match(/^([a-f0-9]+)\s+\d{2}\/\d{2}\/\d{4}\s+(.+)$/);
            if (m) notes.push({ id: m[1], title: m[2].trim() });
            else if (m2) notes.push({ id: m2[1], title: m2[2].trim() });
        }
        return { notebookName, noteCount: notes.length, notes };
    }

    async getNote(noteId) {
        try {
            // Ensure CLI is configured
            await this.configureCli();
            await this.syncIfNeeded();
            
            const { stdout, stderr } = await execAsync(`joplin cat "${noteId}"`);
            
            if (stderr) {
                console.warn('Joplin CLI warning:', stderr);
            }
            
            // The joplin cat command returns the note content directly
            // We need to get the title separately using ls -l
            const { stdout: listOutput } = await execAsync('joplin ls -l');
            const lines = listOutput.split('\n').filter(line => line.trim());
            
            let title = '';
            let created_time = null;
            let updated_time = null;
            
            for (const line of lines) {
                if (line.startsWith(noteId)) {
                    // Match format: ID MM/DD/YYYY HH:MM title
                    const match = line.match(/^([a-f0-9]+)\s+(\d{2}\/\d{2}\/\d{4})\s+(\d{2}:\d{2})\s+(.+)$/);
                    if (match) {
                        title = match[4].trim();
                        // Convert date format from MM/DD/YYYY to ISO format
                        const [month, day, year] = match[2].split('/');
                        const [hour, minute] = match[3].split(':');
                        const dateStr = `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}T${hour}:${minute}:00.000Z`;
                        created_time = new Date(dateStr).getTime();
                        updated_time = created_time; // For now, assume same as created
                        break;
                    }
                }
            }
            
            const note = {
                id: noteId,
                title: title,
                body: stdout.trim(),
                created_time: created_time,
                updated_time: updated_time
            };
            
            return note;
        } catch (error) {
            console.error('❌ Failed to get note:', error.message);
            throw error;
        }
    }

    async updateNote(noteId, updates) {
        try {
            // Ensure CLI is configured
            await this.configureCli();
            
            // Update title if provided
            if (updates.title) {
                const titleCommand = `joplin set "${noteId}" title "${updates.title.replace(/'/g, "'\"'\"'")}"`;
                await execAsync(titleCommand);
            }
            
            // Update body if provided
            if (updates.body) {
                // Create a temporary file with the body content
                const tempFile = join(tmpdir(), `joplin_update_${Date.now()}_${Math.random().toString(36).substr(2, 9)}.md`);
                
                try {
                    writeFileSync(tempFile, updates.body, 'utf8');
                    
                    // Use the file to update the body content
                    const bodyCommand = `joplin set "${noteId}" body "$(cat "${tempFile}")"`;
                    console.log('Updating body content:', updates.body);
                    await execAsync(bodyCommand);
                } finally {
                    // Clean up the temporary file
                    try {
                        unlinkSync(tempFile);
                        console.log('Cleaned up update temp file:', tempFile);
                    } catch (cleanupError) {
                        console.warn('Could not delete update temp file:', cleanupError.message);
                    }
                }
            }
            
            // Sync to ensure changes are uploaded to the server
            await execAsync('joplin sync');
            this._markSynced();
            
            console.log('✅ Note updated successfully:', noteId);
            return { id: noteId, ...updates };
        } catch (error) {
            console.error('❌ Failed to update note:', error.message);
            throw error;
        }
    }

    async deleteNote(noteId) {
        try {
            // Ensure CLI is configured
            await this.configureCli();
            
            const { stdout, stderr } = await execAsync(`joplin rmnote "${noteId}"`);
            
            if (stderr) {
                console.warn('Joplin CLI warning:', stderr);
            }
            
            // Sync to ensure deletion is uploaded to the server
            await execAsync('joplin sync');
            this._markSynced();
            
            console.log('✅ Note deleted successfully:', noteId);
            return true;
        } catch (error) {
            console.error('❌ Failed to delete note:', error.message);
            throw error;
        }
    }
}

// Create a singleton instance
const joplinAPI = new JoplinAPI();

export default joplinAPI;
