const mongoose= require('mongoose');
const Schema = mongoose.Schema;
const passportLocalMongoose= require('passport-local-mongoose');
const passport = require('passport');


const UserSchema = new Schema({
    email:{
        type:String,
        required:true,
        unique : true
    },
    contact:{
        type:String,
        // required:true,
        unique : true
    },
    address:{
        type:String,
        // required:true,
        unique : true
    },
    // IIT (ISM) department code — stored at registration. Used by:
    //   - the chat agent's get_user_profile tool to seed taste-vector
    //     defaults for cold-start users (department-based init,
    //     thesis §3.3.4)
    //   - future analytics on who's borrowing what across departments
    // Kept as a free string of the canonical 17-department codes
    // (IITISM_DEPARTMENTS in app.js); not enforced as enum here so a
    // future department addition doesn't require a schema migration.
    // Optional — old accounts created before this field existed
    // simply have it undefined, which is treated as "unknown" by the
    // taste-vector cold-start logic.
    department:{
        type:String,
        default:"",
    },
    blockedUsers: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
    borrowedBooks: [{ type: Schema.Types.ObjectId, ref: 'Books' }]
});

UserSchema.plugin(passportLocalMongoose);

module.exports = mongoose.model('User',UserSchema);