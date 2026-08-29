# Diagram engine — rules for ERD diagrams

An ERD (entity relationship diagram — the picture of tables and how they
reference each other) uses the same document, the same tools, and the same
rule: you emit meaning, never coordinates. The layout engine decides where
every table sits and how every line is routed.

## When to use type "entity"

entity   one database table or one domain entity, drawn as a box with a
         list of columns

Use "entity" when the thing has COLUMNS you are showing. Use the
architecture types (service, database, queue, cache, storage, client,
external) when you are showing a system that RUNS. "Postgres" as a box in
an architecture diagram is type "database"; the "orders" table inside that
Postgres is type "entity".

Only "entity" nodes may carry fields. A patch putting fields on a service
is rejected with:

    node "api-gateway" has fields but type is "service":
    use type "entity" for tables with columns

## Fields

A field is one column:

    name      the column name, exactly as it is in the database
    type      the column type, 1-24 chars
    pk        true if the column is part of the primary key
    fk        true if the column is a foreign key into another entity
    nullable  true if the column accepts NULL
    note      an optional short annotation, 1-60 chars

Only `name` is required. Omitted `nullable` means "not stated", not "NOT
NULL" — do not set it unless you know.

A row on the diagram shows the name, the type and the PK/FK badges — one
line, never wrapped. A field `note` is not drawn on the row: it appears in
the hover panel, with everything else about the column. Write notes for
the reader who hovers, and keep what must be visible at a glance in the
name and the type.

## Rules

1. IDS COME FROM TABLE NAMES. The table "order_items" becomes the id
   "order-items" with label "order_items". Keep the label spelled the
   way the database spells it; the id is the slug.

2. FIELD NAMES ARE UNIQUE within one entity. A duplicate is rejected:

       entity "users" has duplicate field "email": field names must be
       unique within an entity; rename or remove one

3. AN EMPTY ENTITY IS LEGAL. Add the table now, add its columns in a
   later patch. You do not have to know every column to draw the box.

4. REAL TYPES ONLY. When you are reading an actual schema or migration,
   copy the database's own type strings: "uuid", "varchar(255)",
   "timestamptz", "numeric(10,2)", "jsonb". Do not normalise them to
   "string" or "int". When the user only described the table in prose,
   use the plain type they said, or omit the type entirely.

5. DO NOT INVENT COLUMNS. This is rule 8 of the main rules applied to
   tables: no "created_at", no "updated_at", no surrogate "id" unless
   you saw it in a migration, a model file, or the user's description.
   A table with three described columns gets three columns.

6. FOREIGN KEYS ARE MARKED. Set fk: true on the referencing column, and
   set pk: true on every column of the primary key — composite primary
   keys are normal, so several pk: true fields in one entity are fine.

7. CARDINALITY GOES ON THE EDGE, one of:

       "1:1"  "1:N"  "N:1"  "N:M"

   Read left-to-right as from:to. The viewer draws crow's-foot markers
   from it.

8. EDGE DIRECTION IS FK -> PK. The edge runs FROM the table holding the
   foreign key TO the table holding the primary key it points at. An
   "orders" table with a user_id column gives:

       from: "orders", to: "users", cardinality: "N:1"

   because many orders reference one user. Reverse the reading, not the
   edge, when it is more natural to say "a user has many orders" — that
   is the same edge with cardinality "N:1".

9. N:M NEEDS A JOIN TABLE if the database has one. If you can see the
   join table in the schema, draw it as its own entity with two N:1
   edges. Use "N:M" as a single edge only when you are describing the
   relationship at a level above the physical tables.

10. CARDINALITY NEEDS AN ENTITY. Putting it on an edge between two
    services is rejected:

        edge "e3" has cardinality but neither "web-client" nor
        "api-gateway" is an entity: drop the cardinality or change an
        endpoint to type "entity"

11. LABEL THE RELATIONSHIP, not the key. Edge labels are still 1-3
    words: "places", "belongs to", "owns". Omit the label when the
    cardinality and the fk column already say it.

12. ONE DOCUMENT CAN HOLD BOTH. An ERD and an architecture diagram can
    live in the same document. Put the entities in their own group (a
    group of kind "generic" labelled after the database) so the two
    halves read as two pictures. Edges may cross between them — a
    service to the entity it owns is a legitimate edge — but do not put
    cardinality on such an edge unless one end really is a table.

13. GROUPS STILL MEAN BOUNDARIES. For an ERD that is the schema or the
    database the tables live in, not "these three tables are about
    billing". Topic is not a boundary.
