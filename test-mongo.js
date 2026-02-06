// MongoDB Atlas Connection Test (Node.js)
// Replace the connection string below with your actual Atlas connection string

const { MongoClient } = require('mongodb');

const CONNECTION_STRING =
  "mongodb+srv://kojoyeboah53i:saints_salvation2@cluster0.sk4iy96.mongodb.net/generatedslips?retryWrites=true&w=majority";

async function testConnection() {
    console.log('🔍 Testing MongoDB Atlas connection...');
    console.log('Connection string:', CONNECTION_STRING);
    console.log('');

    const client = new MongoClient(CONNECTION_STRING);

    try {
        console.log('⏳ Connecting...');
        await client.connect();
        
        // Ping the database
        await client.db("admin").command({ ping: 1 });
        
        console.log('');
        console.log('✅ SUCCESS! MongoDB Atlas connection working!');
        console.log('');
        
        // List databases
        const databases = await client.db().admin().listDatabases();
        console.log('📊 Available databases:');
        databases.databases.forEach(db => {
            console.log(`  - ${db.name}`);
        });
        
    } catch (error) {
        console.log('');
        console.log('❌ FAILED! Could not connect to MongoDB Atlas');
        console.log('');
        console.log('Error:', error.message);
        console.log('');
        console.log('Check:');
        console.log('  - Username and password are correct');
        console.log('  - IP address is whitelisted in Atlas Network Access');
        console.log('  - Connection string format is correct');
    } finally {
        await client.close();
    }
}

testConnection();