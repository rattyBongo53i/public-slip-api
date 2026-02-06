## RESTful API Structure:

GET    /api/master-slips                    # List all master slips
GET    /api/master-slips/:id               # Get specific master slip
POST   /api/master-slips                   # Create master slip
GET    /api/master-slips/:id/generated-slips # Get slips for master
GET    /api/generated-slips                # List all generated slips
POST   /api/generated-slips/batch         # Batch create generated slips
PATCH  /api/generated-slips/:id/status    # Update slip status
DELETE /api/master-slips/:id/slips        # Delete all slips for master