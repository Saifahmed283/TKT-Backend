-- Editable public About-page content.
-- Migration sessions are internal so the RLS write policies cannot block seeding.
SELECT set_config('app.is_internal', 'true', false);

CREATE TABLE "SiteContent" (
    "key" TEXT NOT NULL,
    "data" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "updatedBy" TEXT,
    CONSTRAINT "SiteContent_pkey" PRIMARY KEY ("key")
);

ALTER TABLE "SiteContent" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "SiteContent" FORCE ROW LEVEL SECURITY;

-- The content is deliberately public; writes require the super-admin context
-- established by requirePermission() before the route touches the table.
CREATE POLICY "rls_site_content_select" ON "SiteContent" FOR SELECT
  USING (true);

CREATE POLICY "rls_site_content_insert" ON "SiteContent" FOR INSERT
  WITH CHECK (app_is_internal() OR app_is_super_admin());

CREATE POLICY "rls_site_content_update" ON "SiteContent" FOR UPDATE
  USING (app_is_internal() OR app_is_super_admin())
  WITH CHECK (app_is_internal() OR app_is_super_admin());

CREATE POLICY "rls_site_content_delete" ON "SiteContent" FOR DELETE
  USING (app_is_internal() OR app_is_super_admin());

INSERT INTO "SiteContent" ("key", "data", "createdAt", "updatedAt")
VALUES (
  'about',
  jsonb_build_object(
    'copy', jsonb_build_object(
      'team', jsonb_build_object(
        'eyebrow', jsonb_build_object('en', 'The Team', 'ar', 'الفريق'),
        'titleA', jsonb_build_object('en', 'The people behind ', 'ar', 'الأشخاص خلف '),
        'titleB', jsonb_build_object('en', 'the experience', 'ar', 'TKT'),
        'badge', jsonb_build_object('en', 'Built with intention', 'ar', 'صُنعت بشغف ودقة')
      ),
      'partners', jsonb_build_object(
        'eyebrow', jsonb_build_object('en', 'Our Partners', 'ar', 'شركاؤنا'),
        'titleA', jsonb_build_object('en', 'Trusted by the teams', 'ar', 'موثوق من الفرق'),
        'titleB', jsonb_build_object('en', 'who build the night.', 'ar', 'التي تصنع الليلة.')
      ),
      'reports', jsonb_build_object(
        'eyebrow', jsonb_build_object('en', 'Field Reports', 'ar', 'آراء من الميدان'),
        'titleA', jsonb_build_object('en', 'Voices from', 'ar', 'أصوات من'),
        'titleB', jsonb_build_object('en', 'the floor.', 'ar', 'قلب الحدث.')
      )
    ),
    'members', jsonb_build_array(
      jsonb_build_object(
        'id', 'team-founder',
        'name', jsonb_build_object('en', 'Founder Name', 'ar', 'اسم المؤسس'),
        'role', jsonb_build_object('en', 'Founder & CEO', 'ar', 'المؤسس والرئيس التنفيذي'),
        'bio', jsonb_build_object(
          'en', 'Leads the vision behind TKT, shaping premium experiences from concept to unforgettable entry.',
          'ar', 'يقود رؤية TKT ويصنع تجارب استثنائية من الفكرة حتى لحظة الدخول.'
        )
      ),
      jsonb_build_object(
        'id', 'team-operations',
        'name', jsonb_build_object('en', 'Team Member', 'ar', 'اسم عضو الفريق'),
        'role', jsonb_build_object('en', 'Operations Lead', 'ar', 'قائد العمليات'),
        'bio', jsonb_build_object(
          'en', 'Builds the systems and on-ground flow that keep every event smooth, secure, and precise.',
          'ar', 'يبني الأنظمة وسير العمل الميداني ليبقى كل حدث سلساً وآمناً ودقيقاً.'
        )
      ),
      jsonb_build_object(
        'id', 'team-experience',
        'name', jsonb_build_object('en', 'Team Member', 'ar', 'اسم عضو الفريق'),
        'role', jsonb_build_object('en', 'Experience Designer', 'ar', 'مصمم التجربة'),
        'bio', jsonb_build_object(
          'en', 'Crafts the visual and human details that make every TKT moment feel intentional.',
          'ar', 'يصمم التفاصيل البصرية والإنسانية التي تجعل كل لحظة في TKT مدروسة ومميزة.'
        )
      )
    ),
    'partners', jsonb_build_array(
      jsonb_build_object('id', 'partner-1', 'name', jsonb_build_object('en', 'NOVA EVENTS', 'ar', 'NOVA EVENTS')),
      jsonb_build_object('id', 'partner-2', 'name', jsonb_build_object('en', 'SIGNALWORKS', 'ar', 'SIGNALWORKS')),
      jsonb_build_object('id', 'partner-3', 'name', jsonb_build_object('en', 'MERIDIAN STAGES', 'ar', 'MERIDIAN STAGES')),
      jsonb_build_object('id', 'partner-4', 'name', jsonb_build_object('en', 'AXIS MEDIA', 'ar', 'AXIS MEDIA')),
      jsonb_build_object('id', 'partner-5', 'name', jsonb_build_object('en', 'HALCYON PROD', 'ar', 'HALCYON PROD')),
      jsonb_build_object('id', 'partner-6', 'name', jsonb_build_object('en', 'ORBITAL SOUND', 'ar', 'ORBITAL SOUND'))
    ),
    'reports', COALESCE(
      (
        SELECT jsonb_agg(
          jsonb_build_object(
            'id', r."id",
            'author', jsonb_build_object('en', r."author", 'ar', r."author"),
            'role', jsonb_build_object('en', COALESCE(r."role", ''), 'ar', COALESCE(r."role", '')),
            'content', jsonb_build_object('en', r."content", 'ar', r."content"),
            'eventName', jsonb_build_object('en', COALESCE(r."eventName", ''), 'ar', COALESCE(r."eventName", ''))
          )
          ORDER BY r."createdAt" DESC
        )
        FROM "PublicReview" r
        WHERE r."visible" = true
      ),
      '[]'::jsonb
    )
  ),
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
)
ON CONFLICT ("key") DO NOTHING;
