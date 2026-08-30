/**
 * controllers/admin/auth.controller.js
 * Admin & Customer Support Helper Staff Authentication & Management Suite.
 *
 * Implements:
 *   - Universal Admin/Staff Login (Super Admin + Helper Employees)
 *   - Helper Staff Provisioning with Corporate Employee IDs (e.g. EMP-10042)
 *   - Department & Skill Allocation (Customer Care, Tech Support, Diagnostics)
 *   - Complete Audit Logging for Employee Logins & Lifecycle Operations
 *   - Admin Self-Credential Management
 */
const User   = require("../../models/User");
const Helper = require("../../models/Helper.model");
const audit  = require("../../security/auditLogger");
const {
  generateAccessToken,
  generateRefreshToken,
  hashToken,
  setTokenCookies,
} = require("../../utils/tokenManager");

/** Safe unified response formatter for both Admin and Helper accounts */
const formatStaffResponse = (account, isHelper = false) => ({
  id:          account._id,
  name:        account.name,
  email:       account.email,
  username:    account.username || null,
  role:        account.role,
  status:      account.status,
  ...(isHelper && {
    employee_id:            account.employee_id,
    assigned_tickets_count: account.assigned_tickets_count || 0,
    resolved_tickets_count: account.resolved_tickets_count || 0,
    last_login_at:          account.last_login_at || null,
  }),
  permissions: {
    is_super_admin:        account.role === "ADMIN",
    can_manage_tickets:    true,
    can_control_devices:   true,
    can_manage_users:      account.role === "ADMIN",
    can_manage_firmware:   account.role === "ADMIN",
    can_provision_helpers: account.role === "ADMIN",
  },
});

// ─────────────────────────────────────────────
// @desc    Admin & Helper Staff Login
// @route   POST /api/admin/login
// @access  Public
// ─────────────────────────────────────────────
exports.adminLogin = async (req, res, next) => {
  try {
    const { username, email, employee_id, identifier, password } = req.body;
    const loginIdentifier = username || email || employee_id || identifier;

    if (!loginIdentifier || !password) {
      return res.status(400).json({
        success: false,
        message: "Please provide your Employee ID / Username / Email and password",
      });
    }

    const cleanIdentifier = String(loginIdentifier).trim();
    const lowerIdentifier = cleanIdentifier.toLowerCase();
    const upperIdentifier = cleanIdentifier.toUpperCase();

    // 1. Check Super Admin collection first
    let account = await User.findOne({
      $or: [
        { username: lowerIdentifier },
        { email: lowerIdentifier },
      ],
      role: "ADMIN",
    }).select("+password +refresh_tokens");

    let isHelper = false;

    // 2. If not found in Super Admins, check Helper Staff collection
    if (!account) {
      account = await Helper.findOne({
        $or: [
          { employee_id: upperIdentifier },
          { username: lowerIdentifier },
          { email: lowerIdentifier },
        ],
      }).select("+password +refresh_tokens");

      if (account) isHelper = true;
    }

    if (!account || !(await account.matchPassword(password))) {
      audit.log({
        req, category: "ADMIN", action: "STAFF_LOGIN_FAILED", status: "FAILURE",
        message: `Failed login attempt for identifier: ${cleanIdentifier}`,
      });

      return res.status(401).json({
        success: false,
        message: "Invalid staff credentials",
      });
    }

    if (account.status && account.status !== "active") {
      return res.status(403).json({
        success: false,
        message: `Account is ${account.status}${account.status_reason ? `: ${account.status_reason}` : ". Contact management."}`,
      });
    }

    // Update last login metrics for Helper employees
    if (isHelper) {
      await Helper.updateOne(
        { _id: account._id },
        {
          $set: {
            last_login_at: new Date(),
            last_login_ip: audit.getClientIp(req),
          },
        }
      );
    }

    // Issue tokens and rotate sessions
    const accessToken  = generateAccessToken(account);
    const refreshToken = generateRefreshToken(account);
    const hashedToken  = hashToken(refreshToken);

    const Model = isHelper ? Helper : User;
    await Model.updateOne(
      { _id: account._id },
      {
        $push: {
          refresh_tokens: {
            $each: [{ token: hashedToken, created_at: new Date() }],
            $slice: -5,
          },
        },
      }
    );

    setTokenCookies(res, accessToken, refreshToken);

    audit.log({
      req,
      category: "ADMIN",
      action: isHelper ? "HELPER_LOGIN" : "ADMIN_LOGIN",
      status: "SUCCESS",
      resource_type: isHelper ? "Helper" : "User",
      resource_id: account._id,
      message: `${isHelper ? `Helper [${account.employee_id}] ${account.name}` : `Admin ${account.email}`} logged in from IP ${audit.getClientIp(req)}`,
      metadata: {
        is_helper: isHelper,
        employee_id: account.employee_id || null,
        role: account.role,
      },
    });

    res.status(200).json({
      success: true,
      message: `${isHelper ? "Helper Staff" : "Administrator"} login successful`,
      accessToken,
      refreshToken,
      data: formatStaffResponse(account, isHelper),
    });
  } catch (error) {
    next(error);
  }
};

// ─────────────────────────────────────────────
// @desc    Get current logged-in staff profile
// @route   GET /api/admin/me
// @access  Private (ADMIN or HELPER)
// ─────────────────────────────────────────────
exports.getAdminProfile = async (req, res, next) => {
  try {
    const isHelper = req.user.role !== "ADMIN" && !!req.user.employee_id;
    res.status(200).json({
      success: true,
      data: formatStaffResponse(req.user, isHelper),
    });
  } catch (error) {
    next(error);
  }
};

// ─────────────────────────────────────────────
// @desc    Update Admin Credentials (Username, Email, Name, Password)
// @route   PUT /api/admin/credentials
// @access  Private (ADMIN or HELPER)
// ─────────────────────────────────────────────
exports.updateAdminCredentials = async (req, res, next) => {
  try {
    const { name, username, email, currentPassword, newPassword } = req.body;
    const isHelper = req.user.role !== "ADMIN" && !!req.user.employee_id;
    const Model = isHelper ? Helper : User;

    const account = await Model.findById(req.user._id).select("+password");
    if (!account) {
      return res.status(404).json({ success: false, message: "Account not found" });
    }

    // Security Defense: Changing sensitive credentials MUST verify current password
    const isSensitiveChange = !!(newPassword || username || email);
    if (isSensitiveChange) {
      if (!currentPassword) {
        return res.status(400).json({
          success: false,
          message: "Current password is required to update username, email, or password",
        });
      }

      const isMatch = await account.matchPassword(currentPassword);
      if (!isMatch) {
        return res.status(400).json({ success: false, message: "Current password is incorrect" });
      }
    }

    if (username && username.toLowerCase() !== account.username) {
      const usernameExists = await Model.exists({
        username: username.toLowerCase().trim(),
        _id: { $ne: account._id },
      });
      if (usernameExists) {
        return res.status(409).json({ success: false, message: "Username is already taken" });
      }
      account.username = username.toLowerCase().trim();
    }

    if (email && email.toLowerCase() !== account.email) {
      const emailExists = await Model.exists({
        email: email.toLowerCase().trim(),
        _id: { $ne: account._id },
      });
      if (emailExists) {
        return res.status(409).json({ success: false, message: "Email is already in use" });
      }
      account.email = email.toLowerCase().trim();
    }

    if (name) account.name = name.trim();

    if (newPassword) {
      if (newPassword.length < 6) {
        return res.status(400).json({ success: false, message: "New password must be at least 6 characters" });
      }
      account.password = newPassword;
    }

    await account.save();

    audit.log({
      req, category: "ADMIN", action: "STAFF_CREDENTIALS_UPDATE", status: "SUCCESS",
      resource_type: isHelper ? "Helper" : "User", resource_id: account._id,
      message: `Staff member ${account.email} updated credentials`,
    });

    res.status(200).json({
      success: true,
      message: "Credentials updated successfully",
      data: formatStaffResponse(account, isHelper),
    });
  } catch (error) {
    next(error);
  }
};

// ─────────────────────────────────────────────
// @desc    Provision new Helper Staff (Customer Care / Tech Support)
// @route   POST /api/admin/helpers
// @access  Private/Admin (Super Admin Only)
// ─────────────────────────────────────────────
exports.createHelperUser = async (req, res, next) => {
  try {
    const {
      name,
      email,
      password,
      employee_id,
      username,
      phonenumber,
      role = "HELPER",
    } = req.body;

    if (!name || !email || !password) {
      return res.status(400).json({
        success: false,
        message: "Name, corporate email, and initial password are required",
      });
    }

    // Auto-generate employee_id if not explicitly provided (e.g. EMP-000101)
    let assignedEmployeeId = employee_id ? String(employee_id).trim().toUpperCase() : null;
    if (!assignedEmployeeId) {
      const count = await Helper.countDocuments();
      assignedEmployeeId = `EMP-${String(count + 1001).padStart(6, "0")}`;
    }

    // Check duplicate employee ID, email, username
    const duplicate = await Helper.exists({
      $or: [
        { employee_id: assignedEmployeeId },
        { email: email.toLowerCase().trim() },
        ...(username ? [{ username: username.toLowerCase().trim() }] : []),
      ],
    });

    if (duplicate) {
      return res.status(409).json({
        success: false,
        message: "A staff employee with that Employee ID, Email, or Username already exists",
      });
    }

    const helper = await Helper.create({
      employee_id: assignedEmployeeId,
      name:        name.trim(),
      email:       email.toLowerCase().trim(),
      username:    username ? username.toLowerCase().trim() : assignedEmployeeId.toLowerCase(),
      password,
      phonenumber: phonenumber || null,
      role:        ["HELPER", "SENIOR_HELPER", "LEAD_SUPPORT"].includes(role) ? role : "HELPER",
      created_by:  req.user._id,
      status:      "active",
    });

    audit.log({
      req, category: "ADMIN", action: "HELPER_PROVISIONED", status: "SUCCESS",
      resource_type: "Helper", resource_id: helper._id,
      message: `Admin ${req.user.email} provisioned staff employee: [${helper.employee_id}] ${helper.name}`,
      metadata: { employee_id: helper.employee_id },
    });

    res.status(201).json({
      success: true,
      message: `Staff member [${helper.employee_id}] created successfully`,
      data: formatStaffResponse(helper, true),
    });
  } catch (error) {
    next(error);
  }
};

// ─────────────────────────────────────────────
// @desc    List all Helper Staff with filters & metrics
// @route   GET /api/admin/helpers?status=active&search=EMP
// @access  Private/Admin
// ─────────────────────────────────────────────
exports.getHelperUsers = async (req, res, next) => {
  try {
    const filter = {};
    if (req.query.role)   filter.role   = req.query.role.toUpperCase();
    if (req.query.status) filter.status = req.query.status;
    if (req.query.search) {
      const rx = new RegExp(req.query.search.trim(), "i");
      filter.$or = [{ name: rx }, { email: rx }, { employee_id: rx }, { username: rx }];
    }

    const helpers = await Helper.find(filter)
      .populate("created_by", "name email")
      .sort({ createdAt: -1 })
      .lean();

    res.status(200).json({
      success: true,
      count: helpers.length,
      data: helpers,
    });
  } catch (error) {
    next(error);
  }
};

// ─────────────────────────────────────────────
// @desc    Get single Helper Staff details & resolution metrics
// @route   GET /api/admin/helpers/:id
// @access  Private/Admin
// ─────────────────────────────────────────────
exports.getHelperById = async (req, res, next) => {
  try {
    const helper = await Helper.findById(req.params.id)
      .populate("created_by", "name email")
      .lean();

    if (!helper) {
      return res.status(404).json({ success: false, message: "Staff member not found" });
    }

    res.status(200).json({
      success: true,
      data: helper,
    });
  } catch (error) {
    next(error);
  }
};

// ─────────────────────────────────────────────
// @desc    Update Helper Staff status or role
// @route   PATCH /api/admin/helpers/:id/status
// @access  Private/Admin
// ─────────────────────────────────────────────
exports.updateHelperStatus = async (req, res, next) => {
  try {
    const { status, status_reason, role } = req.body;
    const allowed = {};

    if (status) {
      const valid = ["active", "on_leave", "suspended", "terminated"];
      if (!valid.includes(status)) {
        return res.status(400).json({ success: false, message: `Status must be one of: ${valid.join(", ")}` });
      }
      allowed.status = status;
      allowed.status_reason = status_reason || null;
    }

    if (role) {
      const validRoles = ["HELPER", "SENIOR_HELPER", "LEAD_SUPPORT"];
      if (!validRoles.includes(role.toUpperCase())) {
        return res.status(400).json({ success: false, message: `Role must be one of: ${validRoles.join(", ")}` });
      }
      allowed.role = role.toUpperCase();
    }

    const updated = await Helper.findByIdAndUpdate(
      req.params.id,
      { $set: allowed },
      { new: true }
    ).lean();

    if (!updated) {
      return res.status(404).json({ success: false, message: "Staff member not found" });
    }

    audit.log({
      req, category: "ADMIN", action: "HELPER_STATUS_UPDATE", status: "SUCCESS",
      resource_type: "Helper", resource_id: req.params.id,
      message: `Staff [${updated.employee_id}] updated → status: ${updated.status}`,
    });

    res.status(200).json({
      success: true,
      message: "Staff member updated successfully",
      data: updated,
    });
  } catch (error) {
    next(error);
  }
};

// ─────────────────────────────────────────────
// @desc    Delete / Terminate a Helper Staff member (Admin only)
// @route   DELETE /api/admin/helpers/:id
// @access  Private/Admin
// ─────────────────────────────────────────────
exports.deleteHelperUser = async (req, res, next) => {
  try {
    const helper = await Helper.findById(req.params.id);
    if (!helper) {
      return res.status(404).json({ success: false, message: "Staff user not found" });
    }

    await Helper.deleteOne({ _id: req.params.id });

    audit.log({
      req,
      category: "ADMIN",
      action: "HELPER_DELETE",
      status: "SUCCESS",
      resource_type: "Helper",
      resource_id: req.params.id,
      message: `Terminated staff member: [${helper.employee_id}] ${helper.email}`,
    });

    res.status(200).json({
      success: true,
      message: `Staff member [${helper.employee_id}] removed successfully`,
    });
  } catch (error) {
    next(error);
  }
};
