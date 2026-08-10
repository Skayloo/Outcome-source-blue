using System;
using Microsoft.EntityFrameworkCore.Migrations;
using Npgsql.EntityFrameworkCore.PostgreSQL.Metadata;

#nullable disable

namespace Outcome.Db.Abstractions.Migrations
{
    /// <inheritdoc />
    public partial class InitialCreate : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.CreateTable(
                name: "audit_log",
                columns: table => new
                {
                    id = table.Column<long>(type: "bigint", nullable: false)
                        .Annotation("Npgsql:ValueGenerationStrategy", NpgsqlValueGenerationStrategy.IdentityByDefaultColumn),
                    actor_id = table.Column<long>(type: "bigint", nullable: false),
                    action = table.Column<string>(type: "text", nullable: false),
                    target_type = table.Column<string>(type: "text", nullable: false),
                    target_id = table.Column<long>(type: "bigint", nullable: false),
                    detail = table.Column<string>(type: "text", nullable: false),
                    created_at = table.Column<DateTime>(type: "timestamp with time zone", nullable: false, defaultValueSql: "now()")
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_audit_log", x => x.id);
                });

            migrationBuilder.CreateTable(
                name: "login_attempts",
                columns: table => new
                {
                    id = table.Column<long>(type: "bigint", nullable: false)
                        .Annotation("Npgsql:ValueGenerationStrategy", NpgsqlValueGenerationStrategy.IdentityByDefaultColumn),
                    ip_address = table.Column<string>(type: "text", nullable: false),
                    username = table.Column<string>(type: "text", nullable: true),
                    success = table.Column<bool>(type: "boolean", nullable: false),
                    timestamp = table.Column<DateTime>(type: "timestamp with time zone", nullable: false, defaultValueSql: "now()")
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_login_attempts", x => x.id);
                });

            migrationBuilder.CreateTable(
                name: "roles",
                columns: table => new
                {
                    id = table.Column<long>(type: "bigint", nullable: false)
                        .Annotation("Npgsql:ValueGenerationStrategy", NpgsqlValueGenerationStrategy.IdentityByDefaultColumn),
                    color = table.Column<string>(type: "text", nullable: true),
                    permissions = table.Column<long>(type: "bigint", nullable: false),
                    position = table.Column<int>(type: "integer", nullable: false),
                    is_default = table.Column<bool>(type: "boolean", nullable: false),
                    name = table.Column<string>(type: "character varying(256)", maxLength: 256, nullable: true),
                    normalized_name = table.Column<string>(type: "character varying(256)", maxLength: 256, nullable: true),
                    concurrency_stamp = table.Column<string>(type: "text", nullable: true)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_roles", x => x.id);
                });

            migrationBuilder.CreateTable(
                name: "settings",
                columns: table => new
                {
                    key = table.Column<string>(type: "text", nullable: false),
                    value = table.Column<string>(type: "text", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_settings", x => x.key);
                });

            migrationBuilder.CreateTable(
                name: "role_claims",
                columns: table => new
                {
                    id = table.Column<int>(type: "integer", nullable: false)
                        .Annotation("Npgsql:ValueGenerationStrategy", NpgsqlValueGenerationStrategy.IdentityByDefaultColumn),
                    role_id = table.Column<long>(type: "bigint", nullable: false),
                    claim_type = table.Column<string>(type: "text", nullable: true),
                    claim_value = table.Column<string>(type: "text", nullable: true)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_role_claims", x => x.id);
                    table.ForeignKey(
                        name: "FK_role_claims_roles_role_id",
                        column: x => x.role_id,
                        principalTable: "roles",
                        principalColumn: "id",
                        onDelete: ReferentialAction.Cascade);
                });

            migrationBuilder.CreateTable(
                name: "users",
                columns: table => new
                {
                    id = table.Column<long>(type: "bigint", nullable: false)
                        .Annotation("Npgsql:ValueGenerationStrategy", NpgsqlValueGenerationStrategy.IdentityByDefaultColumn),
                    avatar = table.Column<string>(type: "text", nullable: true),
                    role_id = table.Column<long>(type: "bigint", nullable: false),
                    totp_secret = table.Column<string>(type: "text", nullable: true),
                    status = table.Column<string>(type: "text", nullable: false),
                    created_at = table.Column<DateTime>(type: "timestamp with time zone", nullable: false, defaultValueSql: "now()"),
                    last_seen = table.Column<DateTime>(type: "timestamp with time zone", nullable: true),
                    banned = table.Column<bool>(type: "boolean", nullable: false),
                    deleted = table.Column<bool>(type: "boolean", nullable: false),
                    deleted_at = table.Column<DateTime>(type: "timestamp with time zone", nullable: true),
                    ban_reason = table.Column<string>(type: "text", nullable: true),
                    ban_expires = table.Column<DateTime>(type: "timestamp with time zone", nullable: true),
                    username = table.Column<string>(type: "character varying(256)", maxLength: 256, nullable: true),
                    normalized_user_name = table.Column<string>(type: "character varying(256)", maxLength: 256, nullable: true),
                    email = table.Column<string>(type: "character varying(256)", maxLength: 256, nullable: true),
                    normalized_email = table.Column<string>(type: "character varying(256)", maxLength: 256, nullable: true),
                    email_confirmed = table.Column<bool>(type: "boolean", nullable: false),
                    password = table.Column<string>(type: "text", nullable: true),
                    security_stamp = table.Column<string>(type: "text", nullable: true),
                    concurrency_stamp = table.Column<string>(type: "text", nullable: true),
                    phone_number = table.Column<string>(type: "text", nullable: true),
                    phone_number_confirmed = table.Column<bool>(type: "boolean", nullable: false),
                    two_factor_enabled = table.Column<bool>(type: "boolean", nullable: false),
                    lockout_end = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: true),
                    lockout_enabled = table.Column<bool>(type: "boolean", nullable: false),
                    access_failed_count = table.Column<int>(type: "integer", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_users", x => x.id);
                    table.ForeignKey(
                        name: "FK_users_roles_role_id",
                        column: x => x.role_id,
                        principalTable: "roles",
                        principalColumn: "id");
                });

            migrationBuilder.CreateTable(
                name: "emoji",
                columns: table => new
                {
                    id = table.Column<long>(type: "bigint", nullable: false)
                        .Annotation("Npgsql:ValueGenerationStrategy", NpgsqlValueGenerationStrategy.IdentityByDefaultColumn),
                    shortcode = table.Column<string>(type: "text", nullable: false),
                    filename = table.Column<string>(type: "text", nullable: false),
                    uploaded_by = table.Column<long>(type: "bigint", nullable: false),
                    created_at = table.Column<DateTime>(type: "timestamp with time zone", nullable: false, defaultValueSql: "now()")
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_emoji", x => x.id);
                    table.ForeignKey(
                        name: "FK_emoji_users_uploaded_by",
                        column: x => x.uploaded_by,
                        principalTable: "users",
                        principalColumn: "id");
                });

            migrationBuilder.CreateTable(
                name: "friendships",
                columns: table => new
                {
                    id = table.Column<long>(type: "bigint", nullable: false)
                        .Annotation("Npgsql:ValueGenerationStrategy", NpgsqlValueGenerationStrategy.IdentityByDefaultColumn),
                    user_low = table.Column<long>(type: "bigint", nullable: false),
                    user_high = table.Column<long>(type: "bigint", nullable: false),
                    requested_by = table.Column<long>(type: "bigint", nullable: false),
                    status = table.Column<string>(type: "text", nullable: false),
                    created_at = table.Column<DateTime>(type: "timestamp with time zone", nullable: false, defaultValueSql: "now()")
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_friendships", x => x.id);
                    table.ForeignKey(
                        name: "FK_friendships_users_user_high",
                        column: x => x.user_high,
                        principalTable: "users",
                        principalColumn: "id",
                        onDelete: ReferentialAction.Cascade);
                    table.ForeignKey(
                        name: "FK_friendships_users_user_low",
                        column: x => x.user_low,
                        principalTable: "users",
                        principalColumn: "id",
                        onDelete: ReferentialAction.Cascade);
                });

            migrationBuilder.CreateTable(
                name: "servers",
                columns: table => new
                {
                    id = table.Column<long>(type: "bigint", nullable: false)
                        .Annotation("Npgsql:ValueGenerationStrategy", NpgsqlValueGenerationStrategy.IdentityByDefaultColumn),
                    name = table.Column<string>(type: "text", nullable: false),
                    owner_id = table.Column<long>(type: "bigint", nullable: false),
                    icon = table.Column<string>(type: "text", nullable: true),
                    deleted = table.Column<bool>(type: "boolean", nullable: false),
                    created_at = table.Column<DateTime>(type: "timestamp with time zone", nullable: false, defaultValueSql: "now()"),
                    is_public = table.Column<bool>(type: "boolean", nullable: false, defaultValue: false),
                    description = table.Column<string>(type: "text", nullable: false, defaultValue: "")
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_servers", x => x.id);
                    table.ForeignKey(
                        name: "FK_servers_users_owner_id",
                        column: x => x.owner_id,
                        principalTable: "users",
                        principalColumn: "id");
                });

            migrationBuilder.CreateTable(
                name: "sessions",
                columns: table => new
                {
                    id = table.Column<long>(type: "bigint", nullable: false)
                        .Annotation("Npgsql:ValueGenerationStrategy", NpgsqlValueGenerationStrategy.IdentityByDefaultColumn),
                    user_id = table.Column<long>(type: "bigint", nullable: false),
                    token = table.Column<string>(type: "text", nullable: false),
                    device = table.Column<string>(type: "text", nullable: true),
                    ip_address = table.Column<string>(type: "text", nullable: true),
                    created_at = table.Column<DateTime>(type: "timestamp with time zone", nullable: false, defaultValueSql: "now()"),
                    last_used = table.Column<DateTime>(type: "timestamp with time zone", nullable: false, defaultValueSql: "now()"),
                    expires_at = table.Column<DateTime>(type: "timestamp with time zone", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_sessions", x => x.id);
                    table.ForeignKey(
                        name: "FK_sessions_users_user_id",
                        column: x => x.user_id,
                        principalTable: "users",
                        principalColumn: "id",
                        onDelete: ReferentialAction.Cascade);
                });

            migrationBuilder.CreateTable(
                name: "sounds",
                columns: table => new
                {
                    id = table.Column<long>(type: "bigint", nullable: false)
                        .Annotation("Npgsql:ValueGenerationStrategy", NpgsqlValueGenerationStrategy.IdentityByDefaultColumn),
                    name = table.Column<string>(type: "text", nullable: false),
                    filename = table.Column<string>(type: "text", nullable: false),
                    duration_ms = table.Column<int>(type: "integer", nullable: false),
                    uploaded_by = table.Column<long>(type: "bigint", nullable: false),
                    created_at = table.Column<DateTime>(type: "timestamp with time zone", nullable: false, defaultValueSql: "now()")
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_sounds", x => x.id);
                    table.ForeignKey(
                        name: "FK_sounds_users_uploaded_by",
                        column: x => x.uploaded_by,
                        principalTable: "users",
                        principalColumn: "id");
                });

            migrationBuilder.CreateTable(
                name: "user_claims",
                columns: table => new
                {
                    id = table.Column<int>(type: "integer", nullable: false)
                        .Annotation("Npgsql:ValueGenerationStrategy", NpgsqlValueGenerationStrategy.IdentityByDefaultColumn),
                    user_id = table.Column<long>(type: "bigint", nullable: false),
                    claim_type = table.Column<string>(type: "text", nullable: true),
                    claim_value = table.Column<string>(type: "text", nullable: true)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_user_claims", x => x.id);
                    table.ForeignKey(
                        name: "FK_user_claims_users_user_id",
                        column: x => x.user_id,
                        principalTable: "users",
                        principalColumn: "id",
                        onDelete: ReferentialAction.Cascade);
                });

            migrationBuilder.CreateTable(
                name: "user_logins",
                columns: table => new
                {
                    login_provider = table.Column<string>(type: "text", nullable: false),
                    provider_key = table.Column<string>(type: "text", nullable: false),
                    provider_display_name = table.Column<string>(type: "text", nullable: true),
                    user_id = table.Column<long>(type: "bigint", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_user_logins", x => new { x.login_provider, x.provider_key });
                    table.ForeignKey(
                        name: "FK_user_logins_users_user_id",
                        column: x => x.user_id,
                        principalTable: "users",
                        principalColumn: "id",
                        onDelete: ReferentialAction.Cascade);
                });

            migrationBuilder.CreateTable(
                name: "user_roles",
                columns: table => new
                {
                    user_id = table.Column<long>(type: "bigint", nullable: false),
                    role_id = table.Column<long>(type: "bigint", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_user_roles", x => new { x.user_id, x.role_id });
                    table.ForeignKey(
                        name: "FK_user_roles_roles_role_id",
                        column: x => x.role_id,
                        principalTable: "roles",
                        principalColumn: "id",
                        onDelete: ReferentialAction.Cascade);
                    table.ForeignKey(
                        name: "FK_user_roles_users_user_id",
                        column: x => x.user_id,
                        principalTable: "users",
                        principalColumn: "id",
                        onDelete: ReferentialAction.Cascade);
                });

            migrationBuilder.CreateTable(
                name: "user_tokens",
                columns: table => new
                {
                    user_id = table.Column<long>(type: "bigint", nullable: false),
                    login_provider = table.Column<string>(type: "text", nullable: false),
                    name = table.Column<string>(type: "text", nullable: false),
                    value = table.Column<string>(type: "text", nullable: true)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_user_tokens", x => new { x.user_id, x.login_provider, x.name });
                    table.ForeignKey(
                        name: "FK_user_tokens_users_user_id",
                        column: x => x.user_id,
                        principalTable: "users",
                        principalColumn: "id",
                        onDelete: ReferentialAction.Cascade);
                });

            migrationBuilder.CreateTable(
                name: "channels",
                columns: table => new
                {
                    id = table.Column<long>(type: "bigint", nullable: false)
                        .Annotation("Npgsql:ValueGenerationStrategy", NpgsqlValueGenerationStrategy.IdentityByDefaultColumn),
                    server_id = table.Column<long>(type: "bigint", nullable: true),
                    name = table.Column<string>(type: "text", nullable: false),
                    type = table.Column<string>(type: "text", nullable: false),
                    category = table.Column<string>(type: "text", nullable: true),
                    topic = table.Column<string>(type: "text", nullable: true),
                    position = table.Column<int>(type: "integer", nullable: false),
                    slow_mode = table.Column<int>(type: "integer", nullable: false),
                    archived = table.Column<bool>(type: "boolean", nullable: false),
                    deleted = table.Column<bool>(type: "boolean", nullable: false),
                    deleted_at = table.Column<DateTime>(type: "timestamp with time zone", nullable: true),
                    created_at = table.Column<DateTime>(type: "timestamp with time zone", nullable: false, defaultValueSql: "now()"),
                    voice_max_users = table.Column<int>(type: "integer", nullable: false),
                    voice_quality = table.Column<string>(type: "text", nullable: true),
                    mixing_threshold = table.Column<int>(type: "integer", nullable: true),
                    voice_max_video = table.Column<int>(type: "integer", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_channels", x => x.id);
                    table.ForeignKey(
                        name: "FK_channels_servers_server_id",
                        column: x => x.server_id,
                        principalTable: "servers",
                        principalColumn: "id",
                        onDelete: ReferentialAction.Cascade);
                });

            migrationBuilder.CreateTable(
                name: "invites",
                columns: table => new
                {
                    id = table.Column<long>(type: "bigint", nullable: false)
                        .Annotation("Npgsql:ValueGenerationStrategy", NpgsqlValueGenerationStrategy.IdentityByDefaultColumn),
                    server_id = table.Column<long>(type: "bigint", nullable: false),
                    code = table.Column<string>(type: "text", nullable: false),
                    created_by = table.Column<long>(type: "bigint", nullable: false),
                    redeemed_by = table.Column<long>(type: "bigint", nullable: true),
                    max_uses = table.Column<int>(type: "integer", nullable: true),
                    use_count = table.Column<int>(type: "integer", nullable: false),
                    expires_at = table.Column<DateTime>(type: "timestamp with time zone", nullable: true),
                    created_at = table.Column<DateTime>(type: "timestamp with time zone", nullable: false, defaultValueSql: "now()"),
                    revoked = table.Column<bool>(type: "boolean", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_invites", x => x.id);
                    table.ForeignKey(
                        name: "FK_invites_servers_server_id",
                        column: x => x.server_id,
                        principalTable: "servers",
                        principalColumn: "id",
                        onDelete: ReferentialAction.Cascade);
                    table.ForeignKey(
                        name: "FK_invites_users_created_by",
                        column: x => x.created_by,
                        principalTable: "users",
                        principalColumn: "id");
                    table.ForeignKey(
                        name: "FK_invites_users_redeemed_by",
                        column: x => x.redeemed_by,
                        principalTable: "users",
                        principalColumn: "id");
                });

            migrationBuilder.CreateTable(
                name: "server_members",
                columns: table => new
                {
                    server_id = table.Column<long>(type: "bigint", nullable: false),
                    user_id = table.Column<long>(type: "bigint", nullable: false),
                    role_id = table.Column<long>(type: "bigint", nullable: true),
                    joined_at = table.Column<DateTime>(type: "timestamp with time zone", nullable: false, defaultValueSql: "now()")
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_server_members", x => new { x.server_id, x.user_id });
                    table.ForeignKey(
                        name: "FK_server_members_roles_role_id",
                        column: x => x.role_id,
                        principalTable: "roles",
                        principalColumn: "id");
                    table.ForeignKey(
                        name: "FK_server_members_servers_server_id",
                        column: x => x.server_id,
                        principalTable: "servers",
                        principalColumn: "id",
                        onDelete: ReferentialAction.Cascade);
                    table.ForeignKey(
                        name: "FK_server_members_users_user_id",
                        column: x => x.user_id,
                        principalTable: "users",
                        principalColumn: "id",
                        onDelete: ReferentialAction.Cascade);
                });

            migrationBuilder.CreateTable(
                name: "channel_override_claims",
                columns: table => new
                {
                    id = table.Column<long>(type: "bigint", nullable: false)
                        .Annotation("Npgsql:ValueGenerationStrategy", NpgsqlValueGenerationStrategy.IdentityByDefaultColumn),
                    channel_id = table.Column<long>(type: "bigint", nullable: false),
                    role_id = table.Column<long>(type: "bigint", nullable: false),
                    permission = table.Column<string>(type: "text", nullable: false),
                    effect = table.Column<string>(type: "text", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_channel_override_claims", x => x.id);
                    table.ForeignKey(
                        name: "FK_channel_override_claims_channels_channel_id",
                        column: x => x.channel_id,
                        principalTable: "channels",
                        principalColumn: "id",
                        onDelete: ReferentialAction.Cascade);
                    table.ForeignKey(
                        name: "FK_channel_override_claims_roles_role_id",
                        column: x => x.role_id,
                        principalTable: "roles",
                        principalColumn: "id",
                        onDelete: ReferentialAction.Cascade);
                });

            migrationBuilder.CreateTable(
                name: "dm_open_state",
                columns: table => new
                {
                    user_id = table.Column<long>(type: "bigint", nullable: false),
                    channel_id = table.Column<long>(type: "bigint", nullable: false),
                    opened_at = table.Column<DateTime>(type: "timestamp with time zone", nullable: false, defaultValueSql: "now()")
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_dm_open_state", x => new { x.user_id, x.channel_id });
                    table.ForeignKey(
                        name: "FK_dm_open_state_channels_channel_id",
                        column: x => x.channel_id,
                        principalTable: "channels",
                        principalColumn: "id",
                        onDelete: ReferentialAction.Cascade);
                    table.ForeignKey(
                        name: "FK_dm_open_state_users_user_id",
                        column: x => x.user_id,
                        principalTable: "users",
                        principalColumn: "id",
                        onDelete: ReferentialAction.Cascade);
                });

            migrationBuilder.CreateTable(
                name: "dm_participants",
                columns: table => new
                {
                    channel_id = table.Column<long>(type: "bigint", nullable: false),
                    user_id = table.Column<long>(type: "bigint", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_dm_participants", x => new { x.channel_id, x.user_id });
                    table.ForeignKey(
                        name: "FK_dm_participants_channels_channel_id",
                        column: x => x.channel_id,
                        principalTable: "channels",
                        principalColumn: "id",
                        onDelete: ReferentialAction.Cascade);
                    table.ForeignKey(
                        name: "FK_dm_participants_users_user_id",
                        column: x => x.user_id,
                        principalTable: "users",
                        principalColumn: "id",
                        onDelete: ReferentialAction.Cascade);
                });

            migrationBuilder.CreateTable(
                name: "messages",
                columns: table => new
                {
                    id = table.Column<long>(type: "bigint", nullable: false)
                        .Annotation("Npgsql:ValueGenerationStrategy", NpgsqlValueGenerationStrategy.IdentityByDefaultColumn),
                    channel_id = table.Column<long>(type: "bigint", nullable: false),
                    user_id = table.Column<long>(type: "bigint", nullable: false),
                    content = table.Column<string>(type: "text", nullable: false),
                    reply_to = table.Column<long>(type: "bigint", nullable: true),
                    edited_at = table.Column<DateTime>(type: "timestamp with time zone", nullable: true),
                    deleted = table.Column<bool>(type: "boolean", nullable: false),
                    pinned = table.Column<bool>(type: "boolean", nullable: false),
                    timestamp = table.Column<DateTime>(type: "timestamp with time zone", nullable: false, defaultValueSql: "now()")
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_messages", x => x.id);
                    table.ForeignKey(
                        name: "FK_messages_channels_channel_id",
                        column: x => x.channel_id,
                        principalTable: "channels",
                        principalColumn: "id",
                        onDelete: ReferentialAction.Cascade);
                    table.ForeignKey(
                        name: "FK_messages_messages_reply_to",
                        column: x => x.reply_to,
                        principalTable: "messages",
                        principalColumn: "id",
                        onDelete: ReferentialAction.SetNull);
                    table.ForeignKey(
                        name: "FK_messages_users_user_id",
                        column: x => x.user_id,
                        principalTable: "users",
                        principalColumn: "id");
                });

            migrationBuilder.CreateTable(
                name: "read_states",
                columns: table => new
                {
                    user_id = table.Column<long>(type: "bigint", nullable: false),
                    channel_id = table.Column<long>(type: "bigint", nullable: false),
                    last_message_id = table.Column<long>(type: "bigint", nullable: false),
                    mention_count = table.Column<int>(type: "integer", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_read_states", x => new { x.user_id, x.channel_id });
                    table.ForeignKey(
                        name: "FK_read_states_channels_channel_id",
                        column: x => x.channel_id,
                        principalTable: "channels",
                        principalColumn: "id",
                        onDelete: ReferentialAction.Cascade);
                    table.ForeignKey(
                        name: "FK_read_states_users_user_id",
                        column: x => x.user_id,
                        principalTable: "users",
                        principalColumn: "id",
                        onDelete: ReferentialAction.Cascade);
                });

            migrationBuilder.CreateTable(
                name: "voice_states",
                columns: table => new
                {
                    user_id = table.Column<long>(type: "bigint", nullable: false),
                    channel_id = table.Column<long>(type: "bigint", nullable: false),
                    muted = table.Column<bool>(type: "boolean", nullable: false),
                    deafened = table.Column<bool>(type: "boolean", nullable: false),
                    speaking = table.Column<bool>(type: "boolean", nullable: false),
                    joined_at = table.Column<DateTime>(type: "timestamp with time zone", nullable: false, defaultValueSql: "now()"),
                    camera = table.Column<bool>(type: "boolean", nullable: false),
                    screenshare = table.Column<bool>(type: "boolean", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_voice_states", x => x.user_id);
                    table.ForeignKey(
                        name: "FK_voice_states_channels_channel_id",
                        column: x => x.channel_id,
                        principalTable: "channels",
                        principalColumn: "id",
                        onDelete: ReferentialAction.Cascade);
                    table.ForeignKey(
                        name: "FK_voice_states_users_user_id",
                        column: x => x.user_id,
                        principalTable: "users",
                        principalColumn: "id",
                        onDelete: ReferentialAction.Cascade);
                });

            migrationBuilder.CreateTable(
                name: "attachments",
                columns: table => new
                {
                    id = table.Column<string>(type: "text", nullable: false),
                    message_id = table.Column<long>(type: "bigint", nullable: true),
                    filename = table.Column<string>(type: "text", nullable: false),
                    stored_as = table.Column<string>(type: "text", nullable: false),
                    mime_type = table.Column<string>(type: "text", nullable: false),
                    size = table.Column<long>(type: "bigint", nullable: false),
                    uploaded_at = table.Column<DateTime>(type: "timestamp with time zone", nullable: false, defaultValueSql: "now()"),
                    width = table.Column<int>(type: "integer", nullable: true),
                    height = table.Column<int>(type: "integer", nullable: true)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_attachments", x => x.id);
                    table.ForeignKey(
                        name: "FK_attachments_messages_message_id",
                        column: x => x.message_id,
                        principalTable: "messages",
                        principalColumn: "id",
                        onDelete: ReferentialAction.Cascade);
                });

            migrationBuilder.CreateTable(
                name: "reactions",
                columns: table => new
                {
                    id = table.Column<long>(type: "bigint", nullable: false)
                        .Annotation("Npgsql:ValueGenerationStrategy", NpgsqlValueGenerationStrategy.IdentityByDefaultColumn),
                    message_id = table.Column<long>(type: "bigint", nullable: false),
                    user_id = table.Column<long>(type: "bigint", nullable: false),
                    emoji = table.Column<string>(type: "text", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_reactions", x => x.id);
                    table.ForeignKey(
                        name: "FK_reactions_messages_message_id",
                        column: x => x.message_id,
                        principalTable: "messages",
                        principalColumn: "id",
                        onDelete: ReferentialAction.Cascade);
                    table.ForeignKey(
                        name: "FK_reactions_users_user_id",
                        column: x => x.user_id,
                        principalTable: "users",
                        principalColumn: "id",
                        onDelete: ReferentialAction.Cascade);
                });

            migrationBuilder.CreateIndex(
                name: "IX_attachments_message_id",
                table: "attachments",
                column: "message_id");

            migrationBuilder.CreateIndex(
                name: "IX_channel_override_claims_channel_id_role_id_permission",
                table: "channel_override_claims",
                columns: new[] { "channel_id", "role_id", "permission" },
                unique: true);

            migrationBuilder.CreateIndex(
                name: "IX_channel_override_claims_role_id",
                table: "channel_override_claims",
                column: "role_id");

            migrationBuilder.CreateIndex(
                name: "IX_channels_server_id",
                table: "channels",
                column: "server_id");

            migrationBuilder.CreateIndex(
                name: "IX_dm_open_state_channel_id",
                table: "dm_open_state",
                column: "channel_id");

            migrationBuilder.CreateIndex(
                name: "IX_dm_participants_user_id",
                table: "dm_participants",
                column: "user_id");

            migrationBuilder.CreateIndex(
                name: "IX_emoji_shortcode",
                table: "emoji",
                column: "shortcode",
                unique: true);

            migrationBuilder.CreateIndex(
                name: "IX_emoji_uploaded_by",
                table: "emoji",
                column: "uploaded_by");

            migrationBuilder.CreateIndex(
                name: "IX_friendships_user_high",
                table: "friendships",
                column: "user_high");

            migrationBuilder.CreateIndex(
                name: "IX_friendships_user_low_user_high",
                table: "friendships",
                columns: new[] { "user_low", "user_high" },
                unique: true);

            migrationBuilder.CreateIndex(
                name: "IX_invites_code",
                table: "invites",
                column: "code",
                unique: true);

            migrationBuilder.CreateIndex(
                name: "IX_invites_created_by",
                table: "invites",
                column: "created_by");

            migrationBuilder.CreateIndex(
                name: "IX_invites_redeemed_by",
                table: "invites",
                column: "redeemed_by");

            migrationBuilder.CreateIndex(
                name: "IX_invites_server_id",
                table: "invites",
                column: "server_id");

            migrationBuilder.CreateIndex(
                name: "IX_messages_channel_id_id",
                table: "messages",
                columns: new[] { "channel_id", "id" });

            migrationBuilder.CreateIndex(
                name: "IX_messages_reply_to",
                table: "messages",
                column: "reply_to");

            migrationBuilder.CreateIndex(
                name: "IX_messages_user_id",
                table: "messages",
                column: "user_id");

            migrationBuilder.CreateIndex(
                name: "IX_reactions_message_id_user_id_emoji",
                table: "reactions",
                columns: new[] { "message_id", "user_id", "emoji" },
                unique: true);

            migrationBuilder.CreateIndex(
                name: "IX_reactions_user_id",
                table: "reactions",
                column: "user_id");

            migrationBuilder.CreateIndex(
                name: "IX_read_states_channel_id",
                table: "read_states",
                column: "channel_id");

            migrationBuilder.CreateIndex(
                name: "IX_role_claims_role_id",
                table: "role_claims",
                column: "role_id");

            migrationBuilder.CreateIndex(
                name: "RoleNameIndex",
                table: "roles",
                column: "normalized_name",
                unique: true);

            migrationBuilder.CreateIndex(
                name: "IX_server_members_role_id",
                table: "server_members",
                column: "role_id");

            migrationBuilder.CreateIndex(
                name: "IX_server_members_user_id",
                table: "server_members",
                column: "user_id");

            migrationBuilder.CreateIndex(
                name: "IX_servers_is_public",
                table: "servers",
                column: "is_public",
                filter: "is_public AND NOT deleted");

            migrationBuilder.CreateIndex(
                name: "IX_servers_owner_id",
                table: "servers",
                column: "owner_id");

            migrationBuilder.CreateIndex(
                name: "IX_sessions_token",
                table: "sessions",
                column: "token",
                unique: true);

            migrationBuilder.CreateIndex(
                name: "IX_sessions_user_id",
                table: "sessions",
                column: "user_id");

            migrationBuilder.CreateIndex(
                name: "IX_sounds_uploaded_by",
                table: "sounds",
                column: "uploaded_by");

            migrationBuilder.CreateIndex(
                name: "IX_user_claims_user_id",
                table: "user_claims",
                column: "user_id");

            migrationBuilder.CreateIndex(
                name: "IX_user_logins_user_id",
                table: "user_logins",
                column: "user_id");

            migrationBuilder.CreateIndex(
                name: "IX_user_roles_role_id",
                table: "user_roles",
                column: "role_id");

            migrationBuilder.CreateIndex(
                name: "EmailIndex",
                table: "users",
                column: "normalized_email");

            migrationBuilder.CreateIndex(
                name: "IX_users_role_id",
                table: "users",
                column: "role_id");

            migrationBuilder.CreateIndex(
                name: "UserNameIndex",
                table: "users",
                column: "normalized_user_name",
                unique: true);

            migrationBuilder.CreateIndex(
                name: "IX_voice_states_channel_id",
                table: "voice_states",
                column: "channel_id");

            // ── Seed data (formerly DbUp 0002/0005) ──────────────────────────────
            // Default roles + claim-based permissions + server settings. Roles get explicit
            // ids 1..4 (users.role_id / DefaultRole.Owner reference them), so the identity
            // sequence is bumped past 4 to avoid a collision with runtime-created roles.
            migrationBuilder.Sql(@"
INSERT INTO roles (id, name, normalized_name, color, permissions, position, is_default) VALUES
    (1, 'Owner',     'OWNER',     '#E74C3C', 2147483647, 100, FALSE),
    (2, 'Admin',     'ADMIN',     '#F39C12', 1073741823,  80, FALSE),
    (3, 'Moderator', 'MODERATOR', '#3498DB',    1048575,  60, FALSE),
    (4, 'Member',    'MEMBER',    NULL,            7779,  40, TRUE)
ON CONFLICT (id) DO NOTHING;

SELECT setval(pg_get_serial_sequence('roles', 'id'), GREATEST((SELECT MAX(id) FROM roles), 1));

INSERT INTO role_claims (role_id, claim_type, claim_value) VALUES
    (1, 'Permissions', 'Administrator'),
    (2, 'Permissions', 'Administrator'),
    (3, 'Permissions', 'ManageMessages'),
    (3, 'Permissions', 'KickMembers'),
    (3, 'Permissions', 'MuteMembers'),
    (3, 'Permissions', 'ViewAuditLog'),
    (3, 'Permissions', 'ManageInvites'),
    (3, 'Permissions', 'SendMessages'),
    (3, 'Permissions', 'ReadMessages'),
    (3, 'Permissions', 'AttachFiles'),
    (3, 'Permissions', 'AddReactions'),
    (3, 'Permissions', 'UseSoundboard'),
    (3, 'Permissions', 'ConnectVoice'),
    (3, 'Permissions', 'SpeakVoice'),
    (3, 'Permissions', 'UseVideo'),
    (3, 'Permissions', 'ShareScreen'),
    (4, 'Permissions', 'SendMessages'),
    (4, 'Permissions', 'ReadMessages'),
    (4, 'Permissions', 'AttachFiles'),
    (4, 'Permissions', 'AddReactions'),
    (4, 'Permissions', 'UseSoundboard'),
    (4, 'Permissions', 'ConnectVoice'),
    (4, 'Permissions', 'SpeakVoice'),
    (4, 'Permissions', 'UseVideo'),
    (4, 'Permissions', 'ShareScreen');

INSERT INTO settings (key, value) VALUES
    ('server_name',        'Outcome Server'),
    ('server_icon',        ''),
    ('motd',               'Welcome!'),
    ('max_upload_bytes',   '26214400'),
    ('voice_quality',      'high'),
    ('require_2fa',        '0'),
    ('registration_open',  '1'),
    ('backup_schedule',    'daily'),
    ('backup_retention',   '7'),
    ('schema_version',     '1')
ON CONFLICT (key) DO NOTHING;
");
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropTable(
                name: "attachments");

            migrationBuilder.DropTable(
                name: "audit_log");

            migrationBuilder.DropTable(
                name: "channel_override_claims");

            migrationBuilder.DropTable(
                name: "dm_open_state");

            migrationBuilder.DropTable(
                name: "dm_participants");

            migrationBuilder.DropTable(
                name: "emoji");

            migrationBuilder.DropTable(
                name: "friendships");

            migrationBuilder.DropTable(
                name: "invites");

            migrationBuilder.DropTable(
                name: "login_attempts");

            migrationBuilder.DropTable(
                name: "reactions");

            migrationBuilder.DropTable(
                name: "read_states");

            migrationBuilder.DropTable(
                name: "role_claims");

            migrationBuilder.DropTable(
                name: "server_members");

            migrationBuilder.DropTable(
                name: "sessions");

            migrationBuilder.DropTable(
                name: "settings");

            migrationBuilder.DropTable(
                name: "sounds");

            migrationBuilder.DropTable(
                name: "user_claims");

            migrationBuilder.DropTable(
                name: "user_logins");

            migrationBuilder.DropTable(
                name: "user_roles");

            migrationBuilder.DropTable(
                name: "user_tokens");

            migrationBuilder.DropTable(
                name: "voice_states");

            migrationBuilder.DropTable(
                name: "messages");

            migrationBuilder.DropTable(
                name: "channels");

            migrationBuilder.DropTable(
                name: "servers");

            migrationBuilder.DropTable(
                name: "users");

            migrationBuilder.DropTable(
                name: "roles");
        }
    }
}
