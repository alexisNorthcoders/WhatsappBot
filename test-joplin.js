import joplinAPI from './joplin/index.js';

async function testJoplinConnection() {
    console.log('🧪 Testing Joplin integration thoroughly...');
    
    try {
        // Test connection
        console.log('1. Testing connection...');
        const connectionSuccess = await joplinAPI.checkConnection();
        
        if (!connectionSuccess) {
            console.error('❌ Connection failed');
            return;
        }
        
        console.log('✅ Connection successful');
        
        // Test creating a note
        console.log('2. Testing create note...');
        const testNote = await joplinAPI.createNote(
            'WhatsApp Bot Test Note - ' + new Date().toISOString(),
            'This is a test note created by the WhatsApp bot integration.\n\nIt has multiple lines and should be properly formatted.'
        );
        console.log(`✅ Note created with ID: ${testNote.id}`);
        
        // Test reading the note
        console.log('3. Testing read note...');
        const retrievedNote = await joplinAPI.getNote(testNote.id);
        console.log(`✅ Note retrieved:`);
        console.log(`   Title: ${retrievedNote.title}`);
        console.log(`   Body: ${retrievedNote.body.substring(0, 100)}...`);
        
        // Test updating the note
        console.log('4. Testing update note...');
        const updatedNote = await joplinAPI.updateNote(testNote.id, {
            title: 'Updated: ' + retrievedNote.title,
            body: retrievedNote.body + '\n\n[Updated at ' + new Date().toISOString() + ']'
        });
        console.log(`✅ Note updated successfully`);
        
        // Test searching notes
        console.log('5. Testing search notes...');
        const searchResults = await joplinAPI.searchNotes('WhatsApp Bot');
        console.log(`✅ Found ${searchResults.length} notes matching search`);
        
        // Test listing notebooks
        console.log('6. Testing list notebooks...');
        const notebooks = await joplinAPI.getNotebooks();
        console.log(`✅ Found ${notebooks.length} notebooks`);
        
        // Test deleting the note
        console.log('7. Testing delete note...');
        const deleteSuccess = await joplinAPI.deleteNote(testNote.id);
        if (deleteSuccess) {
            console.log(`✅ Note deleted successfully`);
        }
        
        console.log('🎉 All tests passed! Joplin integration is working correctly.');
        
    } catch (error) {
        console.error('❌ Test failed:', error.message);
        console.error('Stack trace:', error.stack);
    }
}

testJoplinConnection();
