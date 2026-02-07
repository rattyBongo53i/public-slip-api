// Import the dotenv package to load environment variables
require('dotenv').config();

const PORT = process.env.PORT || 3000;  // Set the default port to 3000 if not specified in environment variables
const MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017/mydatabase';  // Default to local DB

// Other server code...