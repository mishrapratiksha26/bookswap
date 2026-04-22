const Joi = require('joi');
module.exports.bookSchema =Joi.object({
    book:Joi.object({
        title:Joi.string().required(),
        author:Joi.string().required(),
        genre:Joi.string().required(),
        description:Joi.string().required(),
        price:Joi.number().required().min(0),
        // Optional academic metadata — only filled for genre = EDUCATIONAL
        course:Joi.string().allow('').optional(),
        department:Joi.string().allow('').optional(),
        publication_year:Joi.number().integer().min(1800).max(2100).optional().allow(''),
        // Physical study material beyond textbooks (hand-written notes,
        // printed lecture slides, hard-copy PYQs). Mirrors the Pdf schema
        // so the curriculum matcher treats digital and physical uniformly.
        resource_type:Joi.string().valid('textbook','notes','previous_papers','reference').optional(),
        // For resource_type = notes
        semester:Joi.number().integer().min(1).max(10).optional().allow('', null),
        topic:Joi.string().allow('').optional(),
        // For resource_type = previous_papers
        exam_type:Joi.string().valid('mid_sem','end_sem','quiz','assignment','').optional(),
        year:Joi.number().integer().min(2000).max(2100).optional().allow('', null)
    }).required(),
    deleteImages:Joi.array()
})

// module.exports.userSchema =Joi.object({
//     book:Joi.object({
//         email:Joi.string().required(),
//        password:Joi.string().required(),
//         contact:Joi.string().required(),
//         address:Joi.string().required(),
       
//     }).required(),
    
// })


module.exports.reviewSchema=Joi.object({
    review:Joi.object({
        rating:Joi.number().required(),
        body: Joi.string().required()
    }).required()
})
module.exports.orderSchema=Joi.object({
    order:Joi.object({
        amount:Joi.string().required(),
        payee:Joi.string().required(),
        purchase:Joi.string().required(),
        address:Joi.string().required(),
        contact:Joi.string().required(),

    }).required()
})